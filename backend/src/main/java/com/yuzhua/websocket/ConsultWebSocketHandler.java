package com.yuzhua.websocket;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhua.common.BizException;
import com.yuzhua.entity.ConsultMessage;
import com.yuzhua.security.LoginUser;
import com.yuzhua.security.AccountGuard;
import com.yuzhua.security.UserContext;
import com.yuzhua.security.WsHandshakeInterceptor;
import com.yuzhua.service.ConsultService;
import com.yuzhua.websocket.ConsultSocketRegistry.Conn;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 图文问诊的 WebSocket 端点。
 *
 * 协议是四类上行 / 五类下行，都用 {type: ...} 的 JSON 信封：
 *   上行 SUBSCRIBE / CHAT / READ / PING
 *   下行 READY / HISTORY / MSG / READ / PRESENCE / ERROR / PONG
 * 消息一律先落库再推送：连接只是投递通道，历史以库为准，
 * 所以断线重连后前端重新 SUBSCRIBE 就能补齐，不依赖推送不丢。
 * SUBSCRIBE 只补历史，不写已读；已读只认显式 READ 帧（见 subscribe / read 的注释）。
 *
 * 握手线程和这里都不是 MVC 的 HandlerInterceptor 管辖范围，
 * 所以进入业务方法前手动把登录态塞进 UserContext、出来时清掉——
 * 这是这套 ThreadLocal 方案唯一需要额外小心的地方。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ConsultWebSocketHandler extends TextWebSocketHandler {

    public static final String ATTR_CONN = "wsConn";

    private final ConsultService consultService;
    private final ConsultSocketRegistry registry;
    private final ConsultPush consultPush;
    private final ObjectMapper objectMapper;
    private final AccountGuard accountGuard;

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        LoginUser user = user(session);
        // 同一个账号可能有多处并发写（广播 + 回执），包一层串行化发送
        Conn conn = new Conn(ConsultSocketRegistry.keyOf(user), user,
                new ConcurrentWebSocketSessionDecorator(session, 5000, 256 * 1024));
        session.getAttributes().put(ATTR_CONN, conn);

        Conn stale = registry.open(conn);
        if (stale != null) {
            closeQuietly(stale);
        }
        runAs(user, () -> {
            if (user.isDoctor()) {
                consultService.markDoctorOnline(user.getDoctorId(), true);
            }
            writeControl(conn, envelope("READY", Map.of("name", String.valueOf(user.getName()))));
            Object sid = session.getAttributes().get(WsHandshakeInterceptor.ATTR_SESSION_ID);
            if (sid instanceof Long id) {
                subscribe(conn, id);
            }
        });
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        Conn conn = conn(session);
        if (conn == null) {
            return;
        }
        if (!accountGuard.active(conn.getUser())) {
            err(conn, "账号状态或权限已变化，请重新登录");
            try {
                conn.getWs().close(CloseStatus.POLICY_VIOLATION.withReason("account disabled"));
            } catch (IOException e) {
                log.debug("关闭停用账号连接失败 key={}", conn.getKey());
            }
            return;
        }
        Map<String, Object> payload;
        try {
            payload = objectMapper.readValue(message.getPayload(), new TypeReference<>() {
            });
        } catch (Exception e) {
            writeControl(conn, envelope("ERROR", Map.of("msg", "消息不是合法 JSON")));
            return;
        }
        String type = str(payload.get("type"));
        Long sessionId = asLong(payload.get("sessionId"));
        runAs(conn.getUser(), () -> {
            switch (type == null ? "" : type.toUpperCase()) {
                case "SUBSCRIBE" -> subscribe(conn, sessionId);
                case "CHAT" -> {
                    String requestId = str(payload.get("requestId"));
                    try {
                        chat(conn, sessionId, str(payload.get("msgType")), str(payload.get("content")), requestId);
                    } catch (BizException e) {
                        chatFailed(conn, e.getMessage(), requestId);
                    } catch (RuntimeException e) {
                        // 非预期异常同样要按 requestId 回执，否则前端只能等超时
                        log.error("问诊消息保存失败 key={}", conn.getKey(), e);
                        chatFailed(conn, "消息未保存，请稍后重试", requestId);
                    }
                }
                case "READ" -> read(conn, sessionId);
                case "PING" -> writeControl(conn, envelope("PONG", Map.of()));
                default -> err(conn, "不支持的消息类型：" + type);
            }
        });
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Conn conn = conn(session);
        if (conn == null) {
            return;
        }
        // 顶号时前者关闭，登记表里已经是新连接，这时不能改在线状态。
        // close 内部是原子条件删除：即使关闭回调与新连接登记并发，也不会误删新连接。
        if (registry.close(conn.getKey(), conn) == null) {
            return;
        }
        LoginUser user = conn.getUser();
        if (!user.isDoctor()) {
            return;
        }
        for (Long roomId : conn.getRooms()) {
            broadcast(roomId, envelope("PRESENCE", Map.of("sessionId", roomId, "doctorOnline", false)), conn.getKey());
        }
        if (!registry.doctorConnected(user.getDoctorId())) {
            consultService.markDoctorOnline(user.getDoctorId(), false);
        }
    }

    // ---------------------------------------------------------------- 指令

    /**
     * 进房并补发最近消息。
     *
     * <p><strong>这里不写已读。</strong>进房只证明客户端连上了，不证明有人看见了内容：
     * 页面刷新、断线重连、手机锁屏解锁都会重新 SUBSCRIBE，后台标签页也可能一直挂着连接。
     * 原先 subscribe 直接 markRead，效果是"重连一次就把对侧消息全部标成已读"，
     * 未读红点会在没有任何人查看的情况下消失。
     *
     * <p>已读只由上行 READ 帧触发（{@link #read}）；前端在页面可见且历史渲染完成后才发。
     * REST 的 {@code POST /admin/consult/{id}/read} 保留，用于回归脚本驱动竞态用例。
     */
    private void subscribe(Conn conn, Long sessionId) {
        if (sessionId == null) {
            err(conn, "缺少 sessionId");
            return;
        }
        join(conn, sessionId);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", sessionId);
        data.put("messages", consultService.recent(sessionId, 20));
        write(conn, sessionId, envelope("HISTORY", data));
        write(conn, sessionId, envelope("PRESENCE", Map.of("sessionId", sessionId, "doctorOnline",
                registry.inRoom(sessionId).stream().anyMatch(c -> c.getUser().isDoctor()))));
    }

    private void chat(Conn conn, Long sessionId, String msgType, String content, String requestId) {
        if (sessionId == null) {
            err(conn, "缺少 sessionId");
            return;
        }
        // 未进房时自动进一次：join 里会先校验当事人身份，不信任前端
        join(conn, sessionId);
        // 未读不由"对方是否在线"决定：在线只代表推送此刻可能成功，丢帧时计数会永久漏记
        ConsultMessage msg = consultService.send(sessionId, msgType, content);
        broadcast(sessionId, envelope("MSG", Map.of("message", msg)), null);
        if (requestId != null) write(conn, sessionId, envelope("ACK", Map.of("sessionId", sessionId, "requestId", requestId, "message", msg)));
    }

    private void read(Conn conn, Long sessionId) {
        if (sessionId == null) {
            err(conn, "缺少 sessionId");
            return;
        }
        join(conn, sessionId);
        List<Long> ids = consultService.markRead(sessionId);
        broadcastRead(conn, sessionId, ids);
    }

    /**
     * 已读回执只携带本次事务实际由未读改为已读的消息ID（readMessageIds），
     * 单帧最多200个、超过分帧；没有增量也发一帧空数组，保证请求有回执。
     */
    private void broadcastRead(Conn conn, Long sessionId, List<Long> ids) {
        String role = conn.getUser().isDoctor() ? ConsultMessage.ROLE_DOCTOR : ConsultMessage.ROLE_USER;
        if (ids.isEmpty()) {
            broadcast(sessionId, envelope("READ", Map.of(
                    "sessionId", sessionId, "role", role, "readMessageIds", List.of())), conn.getKey());
            return;
        }
        for (int from = 0; from < ids.size(); from += 200) {
            List<Long> batch = ids.subList(from, Math.min(from + 200, ids.size()));
            broadcast(sessionId, envelope("READ", Map.of(
                    "sessionId", sessionId, "role", role, "readMessageIds", batch)), conn.getKey());
        }
    }

    /**
     * 进房。身份与处置校验必须在登记房间之前，否则任何人都能订阅别人的会话；
     * 已在房间里也要重新校验，权限收回后不能靠旧订阅继续收消息。
     */
    private void join(Conn conn, Long sessionId) {
        consultService.requireMember(sessionId);
        if (conn.getRooms().contains(sessionId)) {
            return;
        }
        registry.join(conn, sessionId);
        if (conn.getUser().isDoctor()) {
            broadcast(sessionId, envelope("PRESENCE", Map.of("sessionId", sessionId, "doctorOnline", true)), conn.getKey());
        }
    }

    // ---------------------------------------------------------------- 收发

    private void broadcast(Long roomId, Map<String, Object> payload, String exceptKey) {
        List<Conn> targets = registry.inRoom(roomId);
        for (Conn c : targets) {
            if (exceptKey == null || !exceptKey.equals(c.getKey())) {
                write(c, roomId, payload);
            }
        }
    }

    /** 业务帧：交给共用出口，发送前按会话校验接收方 */
    private void write(Conn conn, Long sessionId, Map<String, Object> payload) {
        consultPush.send(conn, sessionId, payload);
    }

    /** 控制帧：只校验账号与令牌，不涉及会话内容 */
    private void writeControl(Conn conn, Map<String, Object> payload) {
        consultPush.sendControl(conn, payload);
    }

    private void err(Conn conn, String msg) {
        writeControl(conn, envelope("ERROR", Map.of("msg", msg)));
    }

    /**
     * 发送失败回执。requestId 必须原样带回：前端靠它把这次失败对应到具体一条草稿，
     * 缺失时只能等 10 秒超时，用户看到的是"点了发送没反应"。
     * 业务拒绝与非预期异常走同一个出口，避免异常类型决定了回执长什么样。
     */
    private void chatFailed(Conn conn, String msg, String requestId) {
        Map<String, Object> data = new HashMap<>();
        data.put("msg", msg == null || msg.isBlank() ? "消息未保存，请稍后重试" : msg);
        data.put("requestId", requestId == null ? "" : requestId);
        writeControl(conn, envelope("ERROR", data));
    }

    private Map<String, Object> envelope(String type, Map<String, Object> data) {
        Map<String, Object> out = new HashMap<>(data);
        out.put("type", type);
        return out;
    }

    private void closeQuietly(Conn conn) {
        try {
            conn.getWs().close(CloseStatus.NORMAL.withReason("replaced"));
        } catch (IOException e) {
            log.debug("关闭被顶掉的连接失败 key={}", conn.getKey());
        }
    }

    // ---------------------------------------------------------------- 上下文

    /** WebSocket 回调线程没有拦截器写入的登录态，业务方法前后要自己管 ThreadLocal */
    private void runAs(LoginUser user, Runnable body) {
        UserContext.set(user);
        try {
            body.run();
        } catch (BizException e) {
            err(connOf(user), e.getMessage());
        } catch (Exception e) {
            log.error("WebSocket 处理异常 key={}", user == null ? "?" : user.getId(), e);
            err(connOf(user), "服务处理失败，请稍后重试");
        } finally {
            UserContext.clear();
        }
    }

    /** 出错回执可能落在被顶掉的旧连接上，按 key 回查当前连接 */
    private Conn connOf(LoginUser user) {
        Conn cur = registry.find(ConsultSocketRegistry.keyOf(user));
        return cur == null ? new Conn(ConsultSocketRegistry.keyOf(user), user, null) : cur;
    }

    private static LoginUser user(WebSocketSession session) {
        return (LoginUser) session.getAttributes().get(WsHandshakeInterceptor.ATTR_USER);
    }

    private static Conn conn(WebSocketSession session) {
        Object v = session.getAttributes().get(ATTR_CONN);
        return v instanceof Conn c ? c : null;
    }

    private static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static Long asLong(Object v) {
        if (v instanceof Number n) {
            return n.longValue();
        }
        if (v instanceof String s && !s.isBlank() && s.chars().allMatch(Character::isDigit)) {
            return Long.valueOf(s);
        }
        return null;
    }
}

package com.yuzhua.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import com.yuzhua.common.BizException;
import com.yuzhua.common.BatchLookup;
import com.yuzhua.common.PageResult;
import com.yuzhua.dto.ConsultForm;
import com.yuzhua.dto.ConsultMessageQuery;
import com.yuzhua.dto.ConsultQuery;
import com.yuzhua.entity.ConsultMessage;
import com.yuzhua.entity.ConsultSession;
import com.yuzhua.entity.Doctor;
import com.yuzhua.entity.Pet;
import com.yuzhua.entity.SysUser;
import com.yuzhua.mapper.ConsultMessageMapper;
import com.yuzhua.mapper.ConsultSessionMapper;
import com.yuzhua.mapper.DoctorMapper;
import com.yuzhua.mapper.PetMapper;
import com.yuzhua.mapper.SysUserMapper;
import com.yuzhua.security.LoginUser;
import com.yuzhua.websocket.ConsultPush;
import com.yuzhua.security.UserContext;
import com.yuzhua.vo.ConsultSessionVo;
import com.yuzhua.vo.PetDisplayVo;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * 图文问诊会话与消息。
 *
 * 图文问诊免费、不限量、不建订单：患者在医生主页点「图文问诊」直接建会话（待接诊），
 * 医生接诊后开始沟通，结束由医生点或患者关闭待接诊会话。
 * 发言、已读、未读都按参与方（患者本人 / 接诊医生）校验；管理员不参与对话，
 * 但可在后台只读查看会话与消息用于合规追溯（pageForAdmin / historyForViewer），
 * 并可在只读之上做处置（屏蔽违规消息、无效/违规会话，见 changeMessageHidden / moderate）——
 * 处置只改标志位，发言与已读的参与方校验一行不改。
 * 被处置的会话与消息对参与方视同不存在（列表过滤 + 入口 404），管理员审计视图不过滤。
 *
 * WebSocket 线程和 REST 线程都会调这里，因此身份一律从 UserContext 取；
 * 由调用方（握手/消息处理器）负责在进入前 set、退出前 clear。
 */
@Service
@RequiredArgsConstructor
public class ConsultService extends ServiceImpl<ConsultSessionMapper, ConsultSession> {

    private static final int MAX_TEXT_LEN = 1000;
    private static final int MAX_SUGGEST_LEN = 500;
    private static final int PREVIEW_LEN = 100;
    private static final int RECENT_MAX = 50;

    private final ConsultMessageMapper messageMapper;
    private final ConsultPush consultPush;
    private final PetService petService;
    private final PetMapper petMapper;
    private final DoctorMapper doctorMapper;
    private final SysUserMapper sysUserMapper;

    // ---------------------------------------------------------------- 发起 / 生命周期

    /** 患者发起图文问诊。免费不限量，直接落一条待接诊会话，聊天室随即可用 */
    @Transactional
    public ConsultSessionVo create(ConsultForm req) {
        Pet pet = petService.requireOwned(req.getPetId());
        Doctor doctor = doctorMapper.selectById(req.getDoctorId());
        if (doctor == null) {
            throw BizException.notFound("医生");
        }
        if (doctor.getStatus() != 1) {
            throw new BizException("该医生已停诊，请换个医生");
        }
        ConsultSession s = new ConsultSession();
        s.setUserId(pet.getUserId());
        s.setDoctorId(doctor.getId());
        s.setPetId(pet.getId());
        s.setSymptom(req.getSymptom().trim());
        s.setImages(blankToNull(req.getImages()));
        s.setStatus(ConsultSession.ST_PENDING);
        s.setUserUnread(0);
        s.setDoctorUnread(0);
        save(s);
        // 新建时档案还在，从刚校验过的档案复制展示字段；历史列表则走含已删档案的查询
        PetDisplayVo brief = new PetDisplayVo();
        BeanUtils.copyProperties(pet, brief);
        return buildVo(s, false, brief, doctor, null);
    }

    /**
     * 医生接诊。先锁会话行再判断状态，和发送/结束/处置共用同一把锁；
     * 条件更新仍保留，锁外被其他路径改动时不会误覆盖。
     */
    @Transactional
    public void accept(Long sessionId) {
        ConsultSession s = lockMember(sessionId);
        if (!UserContext.require().isDoctor()) {
            throw BizException.forbidden("只有接诊医生能点接诊");
        }
        if (s.getStatus() != ConsultSession.ST_PENDING) {
            throw new BizException("这个会话不在待接诊状态");
        }
        boolean won = update(Wrappers.<ConsultSession>lambdaUpdate()
                .set(ConsultSession::getStatus, ConsultSession.ST_ACTIVE)
                .set(ConsultSession::getStartTime, LocalDateTime.now())
                .eq(ConsultSession::getId, s.getId())
                .eq(ConsultSession::getStatus, ConsultSession.ST_PENDING));
        if (!won) {
            throw new BizException("这个会话已被接诊，请刷新");
        }
        ConsultMessage sys = systemMessage(s.getId(), "医生已接诊，会话开始。");
        consultPush.push(s.getId(), sessionFrame(s.getId(), ConsultSession.ST_ACTIVE, null, sys));
    }

    /**
     * 结束会话。医生随时可结束，并可附一段问诊小结（线上只建议、确诊要面诊）；
     * 患者只能关掉自己那张还没被接诊的会话，且不能写小结。
     * 先锁会话行：与发送共用一个顺序，结束提示一定落在已提交消息之后，摘要不会被旧消息覆盖。
     */
    @Transactional
    public void close(Long sessionId, String summary) {
        ConsultSession s = lockMember(sessionId);
        boolean byDoctor = UserContext.require().isDoctor();
        if (Integer.valueOf(ConsultSession.ST_CLOSED).equals(s.getStatus())) {
            throw new BizException("会话已经结束了");
        }
        if (!byDoctor && Integer.valueOf(ConsultSession.ST_ACTIVE).equals(s.getStatus())) {
            throw new BizException("医生已接诊，等医生结束本次问诊");
        }
        String concl = byDoctor ? blankToNull(summary) : null;
        if (concl != null && concl.length() > 500) {
            throw new BizException("问诊小结不超过 500 字");
        }
        boolean won = update(Wrappers.<ConsultSession>lambdaUpdate()
                .set(ConsultSession::getStatus, ConsultSession.ST_CLOSED)
                .set(ConsultSession::getEndTime, LocalDateTime.now())
                .set(concl != null, ConsultSession::getSummary, concl)
                .eq(ConsultSession::getId, s.getId())
                .eq(ConsultSession::getStatus, s.getStatus()));
        if (!won) {
            throw new BizException("会话状态刚刚变化，请刷新后再试");
        }
        ConsultMessage sys = systemMessage(s.getId(), byDoctor ? "医生已结束本次问诊。" : "用户已关闭本次问诊。");
        consultPush.push(s.getId(), sessionFrame(s.getId(), ConsultSession.ST_CLOSED, concl, sys));
    }

    /** 会话当事人校验：患者本人或接诊医生，别的账号一律看不到；被处置会话对参与方也视同不存在 */
    public ConsultSession requireMember(Long sessionId) {
        return requireMember(getById(sessionId), sessionId);
    }

    /**
     * 在给定会话快照上做归属与处置校验。读接口传普通读取结果，
     * 写接口传锁读结果——校验对象必须是持锁期间看到的那一行。
     */
    private ConsultSession requireMember(ConsultSession s, Long sessionId) {
        if (s == null) {
            throw BizException.notFound("问诊会话");
        }
        LoginUser u = UserContext.require();
        boolean member = (u.isClient() && s.getUserId().equals(u.getId()))
                || (u.isDoctor() && u.getDoctorId() != null && s.getDoctorId().equals(u.getDoctorId()));
        if (!member) {
            throw BizException.forbidden("只有患者本人和接诊医生能进入这个会话");
        }
        // 被处置的会话对参与方像不存在一样（与列表过滤口径一致）；管理员走 historyForViewer，不经这里
        if (s.getModerateStatus() != null && s.getModerateStatus() != ConsultSession.MV_NORMAL) {
            throw BizException.notFound("问诊会话");
        }
        return s;
    }

    /**
     * 写路径的会话入口：先 SELECT ... FOR UPDATE 取得会话行锁，再在锁内校验归属与处置状态。
     * 锁顺序固定为 会话行 → 消息行，和 markRead / changeMessageHidden 保持一致。
     */
    private ConsultSession lockMember(Long sessionId) {
        return requireMember(baseMapper.selectByIdForUpdate(sessionId), sessionId);
    }

    /** 管理员处置路径：管理员不是参与方，只锁会话并确认存在 */
    private ConsultSession lockSession(Long sessionId) {
        ConsultSession s = baseMapper.selectByIdForUpdate(sessionId);
        if (s == null) {
            throw BizException.notFound("问诊会话");
        }
        return s;
    }

    /** 参与方按 ID 读取会话，历史详情独立于列表分页。 */
    public ConsultSessionVo detailMine(Long id) {
        ConsultSession s = requireMember(id);
        return buildVos(List.of(s), UserContext.require().isDoctor()).get(0);
    }

    /** 我的会话分页，可按诊疗状态筛选。 */
    public PageResult<ConsultSessionVo> pageMine(ConsultQuery q) {
        LoginUser u = UserContext.require();
        if (!u.isClient() && !u.isDoctor()) {
            throw BizException.forbidden("管理员账号不参与问诊会话");
        }
        // 条件式 eq 的第三个实参在调用前就求值了，会把患者账号带进 requireDoctorId 的 403
        Long mineAsDoctor = u.isDoctor() ? UserContext.requireDoctorId() : null;
        LambdaQueryWrapper<ConsultSession> qw = Wrappers.<ConsultSession>lambdaQuery()
                .eq(u.isClient(), ConsultSession::getUserId, u.getId())
                .eq(mineAsDoctor != null, ConsultSession::getDoctorId, mineAsDoctor)
                // 被管理员处置的会话对参与方不可见（红点/列表一处过滤覆盖两端）
                .eq(ConsultSession::getModerateStatus, ConsultSession.MV_NORMAL)
                .eq(q.getStatus() != null, ConsultSession::getStatus, q.getStatus())
                .last("ORDER BY COALESCE(last_message_time, create_time) DESC, id DESC");
        Page<ConsultSession> page = page(new Page<>(q.getPageNum(), q.getPageSize()), qw);
        return PageResult.of(page, buildVos(page.getRecords(), u.isDoctor()));
    }

    /** 管理员只读：全部会话分页（后台「问诊记录」页，可按状态/处置筛）。审计视图不做处置过滤 */
    public PageResult<ConsultSessionVo> pageForAdmin(ConsultQuery q) {
        Page<ConsultSession> page = page(new Page<>(q.getPageNum(), q.getPageSize()),
                Wrappers.<ConsultSession>lambdaQuery()
                        .eq(q.getStatus() != null, ConsultSession::getStatus, q.getStatus())
                        .eq(q.getModerateStatus() != null, ConsultSession::getModerateStatus, q.getModerateStatus())
                        .orderByDesc(ConsultSession::getLastMessageTime)
                        .orderByDesc(ConsultSession::getId));
        return PageResult.of(page, buildVos(page.getRecords(), false));
    }

    /** 两种列表共用历史名称补全，未读数按查看方角色取值。 */
    private List<ConsultSessionVo> buildVos(List<ConsultSession> rows, boolean asDoctor) {
        if (rows.isEmpty()) {
            return List.of();
        }
        Map<Long, PetDisplayVo> pets = BatchLookup.mapByIds(petMapper::selectHistoryDisplay, BatchLookup.ids(rows, ConsultSession::getPetId), PetDisplayVo::getId);
        Map<Long, Doctor> doctors = BatchLookup.mapByIds(doctorMapper::selectBatchIds, BatchLookup.ids(rows, ConsultSession::getDoctorId), Doctor::getId);
        Map<Long, SysUser> users = BatchLookup.mapByIds(sysUserMapper::selectBatchIds, BatchLookup.ids(rows, ConsultSession::getUserId), SysUser::getId);
        List<ConsultSessionVo> out = new ArrayList<>(rows.size());
        for (ConsultSession s : rows) {
            out.add(buildVo(s, asDoctor, pets.get(s.getPetId()), doctors.get(s.getDoctorId()), users.get(s.getUserId())));
        }
        return out;
    }

    /** 历史消息，新→旧分页；beforeId 存在时只查该 id 之前的记录（聊天面板游标翻页） */
    public PageResult<ConsultMessage> history(Long sessionId, ConsultMessageQuery q) {
        requireMember(sessionId);
        return pageHistory(sessionId, q, false);
    }

    /** 历史消息查看口：医生走参与方校验；管理员只读打开（不校验参与方、不清未读，且不过滤屏蔽行） */
    public PageResult<ConsultMessage> historyForViewer(Long sessionId, ConsultMessageQuery q) {
        boolean admin = UserContext.require().isAdmin();
        if (admin) {
            if (getById(sessionId) == null) {
                throw BizException.notFound("问诊会话");
            }
        } else {
            requireMember(sessionId);
        }
        return pageHistory(sessionId, q, admin);
    }

    /** 历史查询的公共构造：分页、beforeId 游标、按 id 倒序；屏蔽行只对管理员审计视图放行 */
    private PageResult<ConsultMessage> pageHistory(Long sessionId, ConsultMessageQuery q, boolean includeHidden) {
        Page<ConsultMessage> page = messageMapper.selectPage(new Page<>(q.getPageNum(), q.getPageSize()),
                Wrappers.<ConsultMessage>lambdaQuery()
                        .eq(ConsultMessage::getSessionId, sessionId)
                        .lt(q.getBeforeId() != null, ConsultMessage::getId, q.getBeforeId())
                        // 管理员审计不过滤：被屏蔽的行仍带 hidden=1 返回，便于复核留痕
                        .eq(!includeHidden, ConsultMessage::getHidden, ConsultMessage.HIDE_NO)
                        .orderByDesc(ConsultMessage::getId));
        return PageResult.of(page);
    }

    /** 进聊天室时一次性带回最近若干条，省一次 REST 往返（被屏蔽的消息不下发） */
    public List<ConsultMessage> recent(Long sessionId, int limit) {
        int n = Math.min(Math.max(limit, 1), RECENT_MAX);
        List<ConsultMessage> rows = messageMapper.selectList(Wrappers.<ConsultMessage>lambdaQuery()
                .eq(ConsultMessage::getSessionId, sessionId)
                .eq(ConsultMessage::getHidden, ConsultMessage.HIDE_NO)
                .orderByDesc(ConsultMessage::getId)
                .last("LIMIT " + n));
        Collections.reverse(rows);
        return rows;
    }

    /**
     * 落一条消息并刷新会话摘要。
     *
     * 未读一律累加，不再看对方是否在线：在线只是"此刻可能看到"，不等于已读——
     * 推送可能因断开而丢失，此时数据库留着未读消息而计数为 0，红点就再也不出来了。
     * 清零只发生在 {@link #markRead}：它把对侧未读消息真正标成已读后把计数归零，
     * 两者同处会话行锁内，顺序由锁保证。
     */
    @Transactional
    public ConsultMessage send(Long sessionId, String msgType, String content) {
        ConsultSession s = lockMember(sessionId);
        LoginUser u = UserContext.require();
        if (Integer.valueOf(ConsultSession.ST_CLOSED).equals(s.getStatus())) {
            throw new BizException("问诊已结束，会话已关闭");
        }
        boolean byDoctor = u.isDoctor();
        String type = msgType == null || msgType.isBlank() ? ConsultMessage.TYPE_TEXT : msgType.trim().toUpperCase();
        if (!ConsultMessage.TYPE_TEXT.equals(type) && !ConsultMessage.TYPE_IMAGE.equals(type)
                && !ConsultMessage.TYPE_SUGGEST.equals(type)) {
            throw new BizException("消息类型只支持 TEXT、IMAGE 或 SUGGEST");
        }
        if (ConsultMessage.TYPE_SUGGEST.equals(type) && !byDoctor) {
            throw new BizException("只有医生能发起到院建议");
        }
        String text = content == null ? "" : content.trim();
        // 到院建议的附言选填：卡片本身就表达了"建议到院"，医生可以不写。
        // 其它类型空消息没意义，仍拦掉
        if (text.isEmpty() && !ConsultMessage.TYPE_SUGGEST.equals(type)) {
            throw new BizException("消息内容不能为空");
        }
        if (ConsultMessage.TYPE_TEXT.equals(type) && text.length() > MAX_TEXT_LEN) {
            throw new BizException("单条消息不超过 " + MAX_TEXT_LEN + " 字");
        }
        if (ConsultMessage.TYPE_IMAGE.equals(type) && text.length() > 255) {
            throw new BizException("图片地址过长");
        }
        if (ConsultMessage.TYPE_SUGGEST.equals(type) && text.length() > MAX_SUGGEST_LEN) {
            throw new BizException("到院建议不超过 " + MAX_SUGGEST_LEN + " 字");
        }

        ConsultMessage m = new ConsultMessage();
        m.setSessionId(s.getId());
        // 后台账号 id 与医生 id 是两套编号，这里存医生侧的业务 id，和会话归属保持一致
        m.setSenderId(byDoctor ? u.getDoctorId() : u.getId());
        m.setSenderRole(byDoctor ? ConsultMessage.ROLE_DOCTOR : ConsultMessage.ROLE_USER);
        m.setSenderName(u.getName());
        m.setSenderAvatar(u.getAvatar());
        m.setMsgType(type);
        m.setContent(text);
        m.setIsRead(0);
        messageMapper.insert(m);
        baseMapper.touchOnMessage(s.getId(), preview(type, text), byDoctor, true);
        return m;
    }

    /** 我读过这个会话了：先锁会话，再锁定对侧可见未读消息按精确ID标记，角标清零；返回本次实际标记的消息ID */
    @Transactional
    public List<Long> markRead(Long sessionId) {
        ConsultSession s = lockMember(sessionId);
        boolean doctor = UserContext.require().isDoctor();
        String role = doctor ? ConsultMessage.ROLE_DOCTOR : ConsultMessage.ROLE_USER;
        List<Long> ids = messageMapper.unreadPeerIdsForUpdate(s.getId(), role);
        for (int from = 0; from < ids.size(); from += 200) {
            List<Long> batch = ids.subList(from, Math.min(from + 200, ids.size()));
            int changed = messageMapper.markPeerRead(s.getId(), role, batch);
            if (changed != batch.size()) {
                throw new IllegalStateException("已读消息更新数量不一致");
            }
        }
        if (doctor) {
            baseMapper.clearDoctorUnread(s.getId());
        } else {
            baseMapper.clearUserUnread(s.getId());
        }
        return ids;
    }

    /** 未读总数，给前端做红点 */
    public long unreadTotal() {
        LoginUser u = UserContext.require();
        if (!u.isClient() && !u.isDoctor()) {
            return 0;
        }
        Long mineAsDoctor = u.isDoctor() ? UserContext.requireDoctorId() : null;
        return count(Wrappers.<ConsultSession>lambdaQuery()
                .eq(u.isClient(), ConsultSession::getUserId, u.getId())
                .eq(mineAsDoctor != null, ConsultSession::getDoctorId, mineAsDoctor)
                // 被处置的会话不进红点，否则角标算给看不见的会话
                .eq(ConsultSession::getModerateStatus, ConsultSession.MV_NORMAL)
                .gt(u.isClient(), ConsultSession::getUserUnread, 0)
                .gt(u.isDoctor(), ConsultSession::getDoctorUnread, 0));
    }

    // ---------------------------------------------------------------- 管理员处置

    /**
     * 管理员屏蔽 / 恢复一条消息。只改标志位，不碰会话状态与参与方已读；
     * 参与方可见性由各查询点过滤（history/recent/WS），管理员审计视图不过滤。
     */
    @Transactional
    public void changeMessageHidden(Long messageId, Integer hidden, String reason) {
        if (hidden == null || (hidden != ConsultMessage.HIDE_NO && hidden != ConsultMessage.HIDE_YES)) {
            throw new BizException("无法完成消息操作，请刷新后重试");
        }
        // 普通读先定位所属会话，不在此处下结论；随后按"会话行 → 消息行"的顺序加锁
        ConsultMessage found = messageMapper.selectById(messageId);
        if (found == null) {
            throw BizException.notFound("问诊消息");
        }
        lockSession(found.getSessionId());
        // 锁内当前读：拿到的是最新已提交状态，避免两个管理员并发改同一条消息时用旧快照判断
        ConsultMessage m = messageMapper.selectByIdForUpdate(messageId);
        if (m == null) {
            throw BizException.notFound("问诊消息");
        }
        boolean hide = hidden == ConsultMessage.HIDE_YES;
        String why = blankToNull(reason);
        if (hide && why == null) {
            throw new BizException("请填写屏蔽原因");
        }
        if (why != null && why.length() > 255) {
            throw new BizException("屏蔽原因不超过 255 字");
        }
        messageMapper.update(null, Wrappers.<ConsultMessage>lambdaUpdate()
                .set(ConsultMessage::getHidden, hidden)
                .set(ConsultMessage::getHiddenReason, hide ? why : null)
                .set(ConsultMessage::getHiddenBy, hide ? UserContext.requireId() : null)
                .set(ConsultMessage::getHiddenTime, hide ? LocalDateTime.now() : null)
                .eq(ConsultMessage::getId, messageId));
        // 被屏蔽/恢复的若是最后一条或未读，会话摘要与角标要按剩余可见消息重算
        refreshSessionAggregates(m.getSessionId());
        m.setHidden(hidden);
        m.setHiddenReason(null);
        m.setHiddenBy(null);
        m.setHiddenTime(null);
        consultPush.push(m.getSessionId(), Map.of("type", "MESSAGE_VISIBILITY", "sessionId", m.getSessionId(),
                "messageId", messageId, "hidden", hidden, "message", hidden == 0 ? m : Map.of()));
    }

    /**
     * 管理员处置会话：1 无效关闭 / 2 违规屏蔽（非 0 连带关闭），0 撤销处置。
     * 与 status 的诊疗生命周期正交；处置后参与方在列表与详情入口都当它不存在。
     */
    @Transactional
    public void moderate(Long sessionId, Integer moderateStatus, String reason) {
        if (moderateStatus == null || moderateStatus < ConsultSession.MV_NORMAL
                || moderateStatus > ConsultSession.MV_VIOLATION) {
            throw new BizException("无法完成会话处置，请刷新后重试");
        }
        // 先锁会话行：处置与发送/结束共用一个顺序，避免处置提交时仍有消息在途
        ConsultSession s = lockSession(sessionId);
        if (moderateStatus == ConsultSession.MV_NORMAL) {
            // 撤销只回写处置字段：已连带关闭的会话保持关闭（诊疗事实不复活）
            update(Wrappers.<ConsultSession>lambdaUpdate()
                    .set(ConsultSession::getModerateStatus, ConsultSession.MV_NORMAL)
                    .set(ConsultSession::getModerateReason, null)
                    .set(ConsultSession::getModerateBy, null)
                    .set(ConsultSession::getModerateTime, null)
                    .eq(ConsultSession::getId, sessionId));
            consultPush.push(sessionId, Map.of("type", "MODERATION", "sessionId", sessionId, "moderateStatus", 0));
            return;
        }
        String why = blankToNull(reason);
        if (why == null) {
            throw new BizException("请填写处置原因");
        }
        if (why.length() > 255) {
            throw new BizException("处置原因不超过 255 字");
        }
        // 未结束的会话连带关闭（条件更新防并发）；已结束的只需记录处置
        boolean closeIt = !Integer.valueOf(ConsultSession.ST_CLOSED).equals(s.getStatus());
        boolean won = update(Wrappers.<ConsultSession>lambdaUpdate()
                .set(ConsultSession::getModerateStatus, moderateStatus)
                .set(ConsultSession::getModerateReason, why)
                .set(ConsultSession::getModerateBy, UserContext.requireId())
                .set(ConsultSession::getModerateTime, LocalDateTime.now())
                .set(closeIt, ConsultSession::getStatus, ConsultSession.ST_CLOSED)
                .set(closeIt, ConsultSession::getEndTime, LocalDateTime.now())
                .eq(ConsultSession::getId, sessionId)
                .eq(closeIt, ConsultSession::getStatus, s.getStatus()));
        if (!won) {
            throw new BizException("会话状态刚刚变化，请刷新后再试");
        }
        if (closeIt) {
            // 该 SYSTEM 消息只在管理员审计视图里可见（参与方已看不到整个会话）——刻意如此
            systemMessage(sessionId, "该会话已由管理员处置关闭。");
        }
        // 处置通知：提交后先发 MODERATION，再清退原订阅，旧连接不能再收到该会话正文
        consultPush.pushModeration(sessionId, Map.of("type", "MODERATION", "sessionId", sessionId, "moderateStatus", moderateStatus));
    }

    /** 屏蔽态变化后重算会话摘要与两侧未读；调用方必须已持有会话行锁。 */
    private void refreshSessionAggregates(Long sessionId) {
        baseMapper.refreshUnread(sessionId);
        // 当前读：本事务在等锁前已做过普通查询，普通 SELECT 会沿用旧快照，漏掉等待期间提交的新消息
        ConsultMessage last = messageMapper.selectLastVisibleForUpdate(sessionId);
        if (last == null) {
            baseMapper.setLastMessage(sessionId, null, null);
        } else {
            baseMapper.setLastMessage(sessionId,
                    preview(last.getMsgType(), last.getContent() == null ? "" : last.getContent()),
                    last.getCreateTime());
        }
    }

    /** 医生上下线：连接建立/断开时由 WebSocket 侧调用 */
    public void markDoctorOnline(Long doctorId, boolean online) {
        doctorMapper.update(null, Wrappers.<Doctor>lambdaUpdate()
                .setSql(online ? "online_status = IF(status = 1, 1, 0)" : "online_status = 0")
                .eq(Doctor::getId, doctorId));
    }

    /** 进程被直接杀掉时断开回调不会执行，留下的在线标志在下次启动时清掉 */
    @PostConstruct
    void resetDoctorOnline() {
        doctorMapper.update(null, Wrappers.<Doctor>lambdaUpdate()
                .set(Doctor::getOnlineStatus, 0)
                .eq(Doctor::getOnlineStatus, 1));
    }

    /**
     * 系统消息：接诊/结束在对话里留个痕。is_read 置 1，
     * 且不涨任何一侧的未读——它不是谁说的话，不该制造红点。
     */
    private ConsultMessage systemMessage(Long sessionId, String text) {
        ConsultMessage m = new ConsultMessage();
        m.setSessionId(sessionId);
        m.setSenderId(0L);
        m.setSenderRole(ConsultMessage.ROLE_SYSTEM);
        m.setSenderName("系统");
        m.setMsgType(ConsultMessage.TYPE_SYSTEM);
        m.setContent(text);
        m.setIsRead(1);
        messageMapper.insert(m);
        baseMapper.touchOnMessage(sessionId, text, false, false);
        return m;
    }

    /** SESSION 帧：附带本次已落库的系统消息（带 ID），前端按消息 ID 合并，另触发父组件刷新会话状态 */
    private Map<String, Object> sessionFrame(Long sessionId, int status, String summary, ConsultMessage message) {
        Map<String, Object> frame = new HashMap<>();
        frame.put("type", "SESSION");
        frame.put("sessionId", sessionId);
        frame.put("status", status);
        frame.put("summary", summary == null ? "" : summary);
        frame.put("message", message);
        return frame;
    }

    private ConsultSessionVo buildVo(ConsultSession s, boolean asDoctor, PetDisplayVo pet, Doctor doctor, SysUser patient) {
        ConsultSessionVo vo = new ConsultSessionVo();
        BeanUtils.copyProperties(s, vo);
        if (pet != null) {
            vo.setPetName(pet.getName());
        }
        if (doctor != null) {
            vo.setDoctorName(doctor.getName());
            vo.setDoctorAvatar(doctor.getAvatar());
        }
        if (patient != null) {
            vo.setUserNickname(patient.getNickname());
            vo.setUserPhone(patient.getPhone());
        }
        vo.setMyUnread(asDoctor ? s.getDoctorUnread() : s.getUserUnread());
        return vo;
    }

    private String preview(String type, String text) {
        if (ConsultMessage.TYPE_IMAGE.equals(type)) {
            return "[图片]";
        }
        if (ConsultMessage.TYPE_SUGGEST.equals(type)) {
            String hint = "[建议到院就医]";
            return text.isEmpty() ? hint : hint + " " + clip(text);
        }
        return clip(text);
    }

    private static String clip(String text) {
        return text.length() <= PREVIEW_LEN ? text : text.substring(0, PREVIEW_LEN) + "…";
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }


}

package com.yuzhua.common;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.regex.Pattern;

/**
 * 给每个 HTTP 请求分配一个追踪号，贯穿响应头与本次请求的全部日志。
 *
 * <p>动机：兜底异常只记 url，同一个接口反复失败时日志里是一串一模一样的行，
 * 用户截图里的"服务器繁忙"没法对应到具体是哪一次。有了追踪号，用户报障时给出的号
 * 能直接在日志里 grep 到那一次的堆栈。
 *
 * <p>入站 {@code X-Trace-Id} 只在符合 {@link #FORMAT} 时沿用——上游网关带了就串联，
 * 其余一律换成新号。这既挡住日志注入（换行、超长），也避免匿名客户端随意指定一个号
 * 把多条请求的日志并成一条。
 *
 * <p>顺序放在最前：鉴权拦截器、业务代码、异常处理器产生的日志都要带上这个号。
 * MDC 是 ThreadLocal，请求结束必须在 finally 里清掉，否则线程复用会把号带给下一个请求。
 *
 * <p><strong>覆盖范围</strong>：只有同步的 MVC 请求。定时任务与 WebSocket 回调没有请求上下文，
 * 日志里这一格为空；{@code OncePerRequestFilter} 的 {@code shouldNotFilterAsyncDispatch} /
 * {@code shouldNotFilterErrorDispatch} 默认是 true，所以将来若引入 {@code @Async} 或异步返回，
 * 异步线程上的日志不会带号（本类不做跨线程传递，需要时用 TaskDecorator 复制 MDC）。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Trace-Id";
    public static final String MDC_KEY = "traceId";

    /**
     * 可以沿用的入站追踪号形状：32 位十六进制。
     *
     * <p>刻意只接受"和本类自己生成的一样"的形状，不接受泛化的 {@code [A-Za-z0-9-]{8,64}}。
     * 原因：{@code /client/**} 与 {@code /admin/auth/login} 都是匿名可达的，泛化白名单等于允许
     * 任意客户端指定 {@code X-Trace-Id: AAAAAAAA}，或用同一个号发两次请求——日志随即合并，
     * "一个 500 对应唯一一行"这个不变量当场失效。限制成 32 位 hex 之后，伪造仍然可能，
     * 但要撞上真实请求的概率被压到可以忽略，且不会与自定义前缀混进同一个字段。
     */
    private static final Pattern FORMAT = Pattern.compile("[0-9a-f]{32}");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String traceId = resolve(request.getHeader(HEADER));
        MDC.put(MDC_KEY, traceId);
        // 响应头先写：即使后面抛异常、由容器直接收尾，客户端也拿得到这个号
        response.setHeader(HEADER, traceId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }

    /** 当前请求的追踪号，只在请求线程内有效；没有（如定时任务、WebSocket 回调）时返回 null */
    public static String current() {
        return MDC.get(MDC_KEY);
    }

    static String resolve(String inbound) {
        return inbound != null && FORMAT.matcher(inbound).matches() ? inbound : newTraceId();
    }

    /** 去掉连字符的 32 位 UUID，比带分隔符的短、适合抄写 */
    private static String newTraceId() {
        return java.util.UUID.randomUUID().toString().replace("-", "");
    }
}

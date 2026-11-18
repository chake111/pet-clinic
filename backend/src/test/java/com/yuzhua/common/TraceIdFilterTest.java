package com.yuzhua.common;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 请求追踪号：入站头的取舍、响应头回写、MDC 生命周期。
 *
 * <p>MDC 是线程级状态，容器会复用线程，所以"请求结束清干净"和"生成一个号"同样重要：
 * 漏清会把上一个请求的号带到下一个请求的日志里，比没有号更难排查。
 */
class TraceIdFilterTest {

    private final TraceIdFilter filter = new TraceIdFilter();

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    @Test
    void keepsWellFormedInboundHeader() {
        // 只认 32 位小写 hex —— 与本类生成的形状一致
        assertEquals("7f3c1d2e9a4b4c8d8e2f1a2b3c4d5e6f",
                TraceIdFilter.resolve("7f3c1d2e9a4b4c8d8e2f1a2b3c4d5e6f"));
    }

    /**
     * 只沿着自己生成的形状（32 位小写 hex）；其余一律换新号。
     *
     * <p>泛化白名单（任意 8–64 位字母数字）会让匿名客户端指定 {@code AAAAAAAA} 或复用同一个号，
     * 把多条请求的日志并成一条；这里连"看起来合理但形状不同"的值也拒掉，包括 W3C traceparent。
     */
    @Test
    void onlyKeepsSelfShapedInboundHeader() {
        String ours = "9d47a390ecb540fba0328bacf05658a0";
        assertEquals(ours, TraceIdFilter.resolve(ours), "自己生成的 32 位 hex 应原样沿用");

        for (String bad : new String[]{
                null, "", "short", "with space", "abc\nDEFGHIJ", "a".repeat(65), "../etc/passwd",
                "AAAAAAAA",                                    // 匿名客户端固定值
                "gateway-abc-12345",                            // 自定义前缀
                "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // W3C traceparent
                "9D47A390ECB540FBA0328BACF05658A0",             // 大写：不是我们生成的形状
                "1234567890"}) {
            String id = TraceIdFilter.resolve(bad);
            assertNotEquals(bad, id, "不应沿用：" + (bad == null ? "null" : bad));
            assertTrue(id.matches("[0-9a-f]{32}"), "新号应为 32 位小写 hex：" + id);
        }
    }

    /** 经 filter 传入合法头时，响应头与请求线程内的 MDC 都用该值（不只是 resolve 纯函数对） */
    @Test
    void preservesInboundHeaderThroughFilter() throws Exception {
        String inbound = "9d47a390ecb540fba0328bacf05658a0";
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/admin/user/abc");
        request.addHeader(TraceIdFilter.HEADER, inbound);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicReference<String> insideRequest = new AtomicReference<>();
        FilterChain chain = (req, res) -> insideRequest.set(MDC.get(TraceIdFilter.MDC_KEY));

        filter.doFilter(request, response, chain);

        assertEquals(inbound, response.getHeader(TraceIdFilter.HEADER));
        assertEquals(inbound, insideRequest.get());
    }

    @Test
    void writesHeaderAndClearsMdcAfterRequest() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/admin/user/abc");
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicReference<String> insideRequest = new AtomicReference<>();
        FilterChain chain = (req, res) -> insideRequest.set(MDC.get(TraceIdFilter.MDC_KEY));

        filter.doFilter(request, response, chain);

        String written = response.getHeader(TraceIdFilter.HEADER);
        assertNotNull(written, "响应头必须带追踪号");
        assertEquals(written, insideRequest.get(), "请求线程内的 MDC 与响应头应是同一个号");
        assertNull(MDC.get(TraceIdFilter.MDC_KEY), "请求结束后必须清掉 MDC，否则线程复用会串号");
    }

    /** 业务代码抛异常时 finally 仍要清 MDC，且响应头已经写上 */
    @Test
    void clearsMdcEvenWhenChainThrows() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/admin/user/abc");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain boom = (req, res) -> {
            throw new IllegalStateException("boom");
        };

        try {
            filter.doFilter(request, response, boom);
        } catch (Exception expected) {
            assertEquals("boom", expected.getMessage());
        }
        assertNotNull(response.getHeader(TraceIdFilter.HEADER));
        assertNull(MDC.get(TraceIdFilter.MDC_KEY));
    }
}

package com.yuzhua.it;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 可观测性端点集成测试：真实 Tomcat + 真实 MySQL。
 *
 * <p>健康分组、Prometheus registry 和指标标签都是 Spring 上下文装配后才生效的配置，
 * 单元测试覆盖不到；这里直接走 HTTP，确认 /api 上下文下的端点和实际输出。
 *
 * <p>Spring Boot 测试上下文默认把 management.defaults.metrics.export.enabled 设为 false，
 * 不加 @AutoConfigureObservability 时连 PrometheusMeterRegistry 都不会创建，端点必然 404。
 */
@AutoConfigureObservability
class ObservabilityIT extends MySqlITSupport {

    @Autowired
    private TestRestTemplate rest;

    @Test
    void readinessAndLivenessAreUpWithDatabase() {
        // TestRestTemplate 的根 URI 已包含 server.servlet.context-path(/api)，这里不要再拼 /api
        // readiness 显式包含 db：数据库可用时应为 UP
        ResponseEntity<String> readiness = rest.getForEntity(
                "/actuator/health/readiness", String.class);
        assertThat(readiness.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(readiness.getBody()).contains("\"status\":\"UP\"");

        // liveness 只看进程，不包含 db
        ResponseEntity<String> liveness = rest.getForEntity(
                "/actuator/health/liveness", String.class);
        assertThat(liveness.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(liveness.getBody()).contains("\"status\":\"UP\"");
    }

    @Test
    void prometheusExposesHttpServerRequestsWithApplicationTag() {
        // 先制造一次真实请求；空闲实例不会凭空出现 http.server.requests
        ResponseEntity<String> home = rest.getForEntity("/client/catalog/home", String.class);
        assertThat(home.getStatusCode()).isEqualTo(HttpStatus.OK);
        // 本项目的 404 也是 HTTP 200 + body.code，必须看 code 才能确认真的打到了接口
        assertThat(home.getBody()).contains("\"code\":200");

        ResponseEntity<String> prometheus = rest.getForEntity(
                "/actuator/prometheus", String.class);
        assertThat(prometheus.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(prometheus.getBody())
                .contains("http_server_requests_seconds_count")
                .contains("http_server_requests_seconds_bucket")
                .contains("application=\"yuzhua-server\"")
                .contains("client/catalog/home");

        // metrics 端点是暴露配置的一部分；p95 的分位数由 Prometheus _bucket 负责，
        // Boot 3.5 的 /actuator/metrics 只返回 count/total/max，这里只确认端点与 meter 可用。
        ResponseEntity<String> metrics = rest.getForEntity(
                "/actuator/metrics/http.server.requests?tag=uri:/client/catalog/home", String.class);
        assertThat(metrics.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(metrics.getBody())
                .contains("\"name\":\"http.server.requests\"")
                .contains("\"statistic\":\"COUNT\"");
    }
}
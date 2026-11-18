package com.yuzhua.config;

import lombok.extern.slf4j.Slf4j;
import org.apache.ibatis.cache.CacheKey;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.BoundSql;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.Interceptor;
import org.apache.ibatis.plugin.Intercepts;
import org.apache.ibatis.plugin.Invocation;
import org.apache.ibatis.plugin.Signature;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.function.LongSupplier;

/**
 * MyBatis 慢 SQL 拦截器：按单条语句计时，只有耗时达到阈值才打 WARN。
 *
 * <p>日志只带 statement id、语句类型、耗时和是否失败，不记录 SQL 文本、参数和异常消息。
 * statement id 已经能定位到 mapper 方法；参数里可能有手机号、症状和病历内容，不能进日志。
 * traceId 由 logging.pattern 里的 %X{traceId:-} 带出，不重复写进消息。
 *
 * <p>计时包住的是单条语句的 Executor 调用：包含行锁等待和结果映射，但不含分页插件拼装 SQL
 * 的开销。分页请求的 count 与主查询会分别计时（statement id 以 _COUNT 结尾的是 count 语句），
 * 不是纯 MySQL 执行时间。压测时同一行上的写事务排队会表现为秒级耗时。
 */
@Slf4j
@Component
// 最高优先级让本拦截器排在 MybatisPlusInterceptor 之前（MyBatis 插件链里先注册的在内层），
// 按单条语句计时，而不是把分页的 count + 查询合在一起算；插件顺序不随 bean 注册顺序变化
@Order(Ordered.HIGHEST_PRECEDENCE)
@Intercepts({
        @Signature(type = Executor.class, method = "query",
                args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        // MyBatis-Plus 的 MybatisPlusInterceptor 拦到 4 参 query 后，会用 6 参 query 调内层 Executor；
        // 只拦 4 参会漏掉真正执行的 SQL，这也是 SELECT 一开始不记日志的原因
        @Signature(type = Executor.class, method = "query",
                args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class,
                        CacheKey.class, BoundSql.class}),
        @Signature(type = Executor.class, method = "update",
                args = {MappedStatement.class, Object.class})
})
public class SlowSqlInterceptor implements Interceptor {

    private final AppProperties appProperties;
    private final LongSupplier nanoClock;

    /**
     * Spring 只使用这个 public 构造器；单测走下面包级可见的构造器注入固定时钟。
     * 两个构造器同时存在时，@Autowired 必须标在 Spring 要用的那个上。
     */
    @Autowired
    public SlowSqlInterceptor(AppProperties appProperties) {
        this(appProperties, System::nanoTime);
    }

    SlowSqlInterceptor(AppProperties appProperties, LongSupplier nanoClock) {
        this.appProperties = appProperties;
        this.nanoClock = nanoClock;
    }

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        long thresholdMs = appProperties.getObservability().getSlowSqlThresholdMs();
        // 阈值为 0 表示关闭：连计时都不做，避免给每条语句增加无意义开销
        if (thresholdMs <= 0) {
            return invocation.proceed();
        }

        MappedStatement mappedStatement = (MappedStatement) invocation.getArgs()[0];
        long startNanos = nanoClock.getAsLong();
        boolean failed = false;
        try {
            return invocation.proceed();
        } catch (Throwable t) {
            failed = true;
            throw t;
        } finally {
            long elapsedMs = (nanoClock.getAsLong() - startNanos) / 1_000_000L;
            // 语义是“达到或超过阈值”；低于阈值不打日志
            if (elapsedMs >= thresholdMs) {
                log.warn("慢 SQL statement={} type={} elapsed={}ms failed={}",
                        mappedStatement.getId(), mappedStatement.getSqlCommandType(), elapsedMs, failed);
            }
        }
    }
}
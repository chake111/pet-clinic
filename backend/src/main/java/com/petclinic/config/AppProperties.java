package com.petclinic.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 应用自定义配置，对应 application.yml 的 petclinic.* 节点。
 */
@Data
@ConfigurationProperties(prefix = "petclinic")
public class AppProperties {

    private Jwt jwt = new Jwt();
    private Upload upload = new Upload();

    /** 未支付订单自动释放号源的分钟数 */
    private int payTimeoutMinutes = 30;

    @Data
    public static class Jwt {
        /**
         * HMAC-SHA 密钥（算法随长度自动选：32B→HS256、48B→HS384、64B→HS512）。
         *
         * <p>刻意不给默认值：代码里留一个"能跑起来"的密钥，就等于给了部署时忘记覆盖的机会。
         * 未配置、过短或仍为历史示例值时，JwtUtils 在启动阶段直接失败。
         */
        private String secret;
        /** 过期时间（秒），默认 7 天 */
        private long expireSeconds = 604800;
        /** 请求头名称 */
        private String header = "Authorization";
        private String prefix = "Bearer ";
    }

    @Data
    public static class Upload {
        /** 文件落盘根目录（相对启动目录或绝对路径） */
        private String dir = "./uploads";
        /**
         * 对外访问前缀。必须带上 server.servlet.context-path（/api），
         * 因为静态映射注册在 context-path 之下，前端拿到这个值会直接当 <img src> 用。
         */
        private String urlPrefix = "/api/uploads";
        private long maxSizeBytes = 5 * 1024 * 1024;
    }
}

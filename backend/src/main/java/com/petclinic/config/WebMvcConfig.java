package com.petclinic.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.petclinic.security.AccountGuard;
import com.petclinic.security.AuthInterceptor;
import com.petclinic.security.JwtUtils;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.file.Paths;

/**
 * Web 层装配：鉴权拦截器、跨域、上传文件的静态访问。
 */
@Configuration
@RequiredArgsConstructor
public class WebMvcConfig implements WebMvcConfigurer {

    private final JwtUtils jwtUtils;
    private final AppProperties props;
    private final AccountGuard accountGuard;
    private final ObjectMapper objectMapper;

    // @Value 放不到 final 上：Lombok 的构造器不会带上这个注解，只能字段注入
    @Value("${server.servlet.context-path:}")
    private String contextPath;

    /**
     * 免登录白名单。
     *
     * <p>公开展示接口集中在 {@code /client/catalog/**}，另外放行用户登录、注册及后台登录。
     * 此配置按路径匹配；catalog 控制器通过只提供读取接口维持公开展示约定。
     */
    private static final String[] PUBLIC_PATHS = {
            "/client/catalog/**",
            "/client/auth/login",
            "/client/auth/register",
            "/admin/auth/login"
    };

    @Bean
    public AuthInterceptor authInterceptor() {
        return new AuthInterceptor(jwtUtils, props, accountGuard, objectMapper);
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor())
                .addPathPatterns("/admin/**", "/client/**", "/common/**")
                .excludePathPatterns(PUBLIC_PATHS);
    }

    /**
     * 开发期直连后端（不经过 Vite 代理）时用到。生产环境由 nginx 同源转发，
     * 这里 allowedOriginPatterns 而非 "*"，是为了允许带 credentials。
     */
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                // X-Trace-Id 要让浏览器里的前端也读得到（直连后端联调时用）。
                // 走 Vite 代理或同源 nginx 时不受 CORS 限制，这里只补齐跨域场景。
                .exposedHeaders("Authorization", "X-Trace-Id")
                .allowCredentials(true)
                .maxAge(3600);
    }

    /**
     * 上传的图片以静态资源方式暴露，不经过 Controller 读流。
     *
     * 契约动机: urlPrefix 是浏览器看到的完整地址（含 context-path），而 Spring 的资源映射模式
     * 在 context-path 之内匹配，注册前必须剥掉这一段、避免重复 /api——
     * 否则服务地址变成 /api/api/uploads/**，库里存的 URL 全都打不开。
     */
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        String location = Paths.get(props.getUpload().getDir()).toAbsolutePath().normalize().toString();
        registry.addResourceHandler(resourcePattern() + "/**")
                .addResourceLocations("file:" + location + "/");
    }

    private String resourcePattern() {
        String prefix = props.getUpload().getUrlPrefix();
        return prefix.startsWith(contextPath) ? prefix.substring(contextPath.length()) : prefix;
    }
}

package com.petclinic.config;

import com.petclinic.security.WsHandshakeInterceptor;
import com.petclinic.websocket.ConsultWebSocketHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

/**
 * 原生 WebSocket 装配（不是 STOMP）。图文问诊只有"给某个会话推消息"这一种需求，
 * 上 STOMP 要多带一套订阅协议，收益不值。
 *
 * 端点挂在 {context-path}/ws/consult，即 ws://host:8081/api/ws/consult；
 * 鉴权在 WsHandshakeInterceptor 里做，所以这里不注册 MVC 拦截器。
 * 空闲超时保持容器默认值，靠前端每 30 秒一次 PING 维持连接。
 */
@Configuration
@EnableWebSocket
@RequiredArgsConstructor
public class WebSocketConfig implements WebSocketConfigurer {

    private final ConsultWebSocketHandler consultHandler;
    private final WsHandshakeInterceptor handshakeInterceptor;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(consultHandler, "/ws/consult")
                .addInterceptors(handshakeInterceptor)
                // 开发期 Vite 在 5173 直连后端；握手已经强制校验 token，跨源本身不放行为匿名连接
                .setAllowedOriginPatterns("*");
    }

    /** 单条文本消息上限 16KB：图片先走 /common/upload，聊天里只传 URL，不需要更大的缓冲 */
    @Bean
    public ServletServerContainerFactoryBean webSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(16 * 1024);
        container.setMaxBinaryMessageBufferSize(4 * 1024);
        return container;
    }
}

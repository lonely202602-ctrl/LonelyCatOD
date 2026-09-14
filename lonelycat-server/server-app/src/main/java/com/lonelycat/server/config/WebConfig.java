package com.lonelycat.server.config;

import com.lonelycat.server.ws.CollabWebSocketHandler;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * 注册 WebSocket 端点 /ws，以及 REST 接口的跨域设置。
 */
@Configuration
@EnableWebSocket
@EnableConfigurationProperties(LonelyCatProperties.class)
public class WebConfig implements WebSocketConfigurer {

    private final CollabWebSocketHandler handler;
    private final LonelyCatProperties props;

    public WebConfig(CollabWebSocketHandler handler, LonelyCatProperties props) {
        this.handler = handler;
        this.props = props;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws")
                .setAllowedOriginPatterns(props.allowedOrigins());
    }

    /** REST 接口跨域：前端开发服务器（如 Vite 的 5173 端口）需要 */
    @Bean
    public WebMvcConfigurer corsConfigurer() {
        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                registry.addMapping("/api/**")
                        .allowedOriginPatterns(props.allowedOrigins())
                        .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS");
            }
        };
    }
}

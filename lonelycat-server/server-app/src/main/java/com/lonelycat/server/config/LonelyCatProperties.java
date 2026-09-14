package com.lonelycat.server.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * application.yml 里 lonelycat.* 的配置项。
 */
@ConfigurationProperties(prefix = "lonelycat")
public record LonelyCatProperties(
        /* 每累计多少个操作写一次快照 */
        int snapshotInterval,
        /* 允许的跨域来源 */
        String allowedOrigins
) {
    public LonelyCatProperties {
        if (snapshotInterval <= 0) {
            snapshotInterval = 20;
        }
        if (allowedOrigins == null || allowedOrigins.isBlank()) {
            allowedOrigins = "*";
        }
    }
}

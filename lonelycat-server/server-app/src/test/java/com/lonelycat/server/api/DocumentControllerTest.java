package com.lonelycat.server.api;

import com.lonelycat.server.api.DocumentController.DocumentSummary;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 文档 REST 生命周期：创建 → 重命名 → 操作日志回放数据 → 删除 → 404。
 * 用真实 HTTP 栈（随机端口）。注意不用默认的 TestRestTemplate：它基于
 * HttpURLConnection，根本发不出 PATCH（Invalid HTTP method），这里换成 JDK HttpClient。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class DocumentControllerTest {

    @LocalServerPort
    private int port;

    private RestTemplate rest;
    private String root;

    @BeforeEach
    void setUp() {
        rest = new RestTemplate(new JdkClientHttpRequestFactory(HttpClient.newHttpClient()));
        // 4xx 不抛异常，按普通响应返回，方便断言 404
        rest.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public void handleError(ClientHttpResponse response) {
                // no-op
            }
        });
        root = "http://localhost:" + port;
    }

    @Test
    void lifecycle() {
        // 创建
        ResponseEntity<DocumentSummary> created = rest.postForEntity(root + "/api/docs",
                new DocumentController.CreateRequest("测试文档-" + UUID.randomUUID(), "hello", "ot"), DocumentSummary.class);
        assertEquals(HttpStatus.CREATED, created.getStatusCode());
        assertNotNull(created.getBody());
        String id = created.getBody().id();

        // 重命名
        ResponseEntity<DocumentSummary> renamed = rest.exchange(root + "/api/docs/" + id, HttpMethod.PATCH,
                new HttpEntity<>(new DocumentController.RenameRequest("改名后的文档")), DocumentSummary.class);
        assertEquals(HttpStatus.OK, renamed.getStatusCode());
        assertEquals("改名后的文档", renamed.getBody().title());

        // 回放数据：还没有任何操作时，快照就是初始内容
        ResponseEntity<Map> replayEmpty = rest.getForEntity(root + "/api/docs/" + id + "/replay", Map.class);
        assertEquals(HttpStatus.OK, replayEmpty.getStatusCode());
        assertEquals("hello", replayEmpty.getBody().get("baseContent"));
        assertEquals(0, ((List<?>) replayEmpty.getBody().get("operations")).size());

        // 删除 → get 404 → replay 404
        ResponseEntity<Void> deleted = rest.exchange(root + "/api/docs/" + id, HttpMethod.DELETE, null, Void.class);
        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, rest.getForEntity(root + "/api/docs/" + id, DocumentSummary.class).getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, rest.getForEntity(root + "/api/docs/" + id + "/replay", Map.class).getStatusCode());

        // 再删一次：幂等地返回 404
        assertEquals(HttpStatus.NOT_FOUND, rest.exchange(root + "/api/docs/" + id, HttpMethod.DELETE, null, Void.class).getStatusCode());
    }

    @Test
    void replayPayloadStructure() {
        String id = rest.postForEntity(root + "/api/docs",
                new DocumentController.CreateRequest("回放-" + UUID.randomUUID(), "", "ot"), DocumentSummary.class).getBody().id();

        // 操作的产生由 e2e 脚本覆盖，这里只验证 REST 载荷结构
        ResponseEntity<Map> replay = rest.getForEntity(root + "/api/docs/" + id + "/replay", Map.class);
        assertEquals(HttpStatus.OK, replay.getStatusCode());
        assertNotNull(replay.getBody().get("baseContent"));
        assertTrue(((List<?>) replay.getBody().get("operations")).isEmpty());

        rest.delete(root + "/api/docs/" + id);
        assertFalse(rest.getForEntity(root + "/api/docs/" + id, DocumentSummary.class).getStatusCode().is2xxSuccessful());
    }
}

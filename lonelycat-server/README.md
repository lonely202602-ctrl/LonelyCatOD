# lonelycat-server

LonelyCat 协同编辑后端，Java 17 + Spring Boot 3，基于 OT（操作转换）实现多人实时编辑。

## 模块

| 模块 | 说明 |
|---|---|
| `ot-core` | 纯 Java OT 算法库：`TextOperation`（retain / insert / delete）和 `OtEngine`（compose / transform）。零 Spring 依赖 |
| `server-app` | Spring Boot 应用：WebSocket 同步端点、文档会话、H2 持久化、REST 接口 |

## 运行

```bash
mvn install                                              # 构建 + 跑全部测试
java -jar server-app/target/server-app-0.1.0-SNAPSHOT.jar   # 监听 9090
```

或者开发时直接：

```bash
mvn -pl server-app spring-boot:run
```

数据库文件在 `./data/lonelycat.mv.db`，调试可打开 http://localhost:9090/h2-console（JDBC URL 填 `jdbc:h2:file:./data/lonelycat`，用户 `sa`，密码留空）。

## 接口

- `GET /api/docs` 文档列表
- `POST /api/docs` 创建文档，body `{"title":"...","content":"..."}`
- `GET /api/docs/{id}` 文档元信息
- `ws://localhost:9090/ws` 实时同步，协议见 [PROTOCOL.md](PROTOCOL.md)

## 代码导读

按数据流向阅读：

1. `ot-core/.../TextOperation.java` 操作的数据结构和 `apply`
2. `ot-core/.../OtEngine.java` `compose` 和 `transform`，OT 的核心
3. `server-app/.../session/DocumentSession.java` 服务器端 OT：收到操作后与历史做转换
4. `server-app/.../session/DocumentService.java` 内存会话 + 数据库快照/操作日志
5. `server-app/.../ws/CollabWebSocketHandler.java` 消息分发和广播
6. `server-app/.../protocol/Message.java` 消息格式

## 配置

`server-app/src/main/resources/application.yml`：

- `server.port` 端口，默认 9090
- `lonelycat.snapshot-interval` 每多少个操作写一次快照，默认 20
- `lonelycat.allowed-origins` 跨域来源，默认 `*`

换 PostgreSQL：改 `spring.datasource.*`，并在 `server-app/pom.xml` 把 h2 换成 postgresql 驱动。

## 已知限制（第一版）

- 单实例。多实例部署需要把文档会话固定到某台机器，或引入 Redis 做操作广播。
- 没有鉴权，任何人都能打开任何文档。
- 操作历史只在内存里保留从本次加载以来的部分；客户端版本落后于快照时会被要求重新 join。

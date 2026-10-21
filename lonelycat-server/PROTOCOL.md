# LonelyCat 同步协议（WebSocket）

前后端之间的契约。前端仓库 `lonelycat-client/packages/sync` 按此实现，改动时两边同步更新。

- 端点：`ws://<host>:9090/ws`
- 编码：每条消息一个 JSON 对象，靠 `type` 字段区分
- 操作格式：数组，正整数 = retain，负整数 = delete，字符串 = insert。例如文档 `chat` 删掉 `h` 是 `[1, -1, 2]`，末尾加 `s` 是 `[4, "s"]`
- 长度单位：UTF-16 代码单元（Java `String.length()` 和 JS `string.length` 一致）

## 客户端 → 服务器

| type | 字段 | 说明 |
|---|---|---|
| `join` | `docId`, `name` | 加入文档。服务器回 `snapshot`，并向房间内其他人广播 `joined` |
| `op` | `docId`, `revision`, `op` | 提交操作。`revision` 是客户端生成该操作时本地所处的版本号 |
| `cursor` | `docId`, `cursor:{anchor, head}` | 广播光标/选区位置 |
| `typing` | `docId` | 「正在输入」心跳。客户端节流发送（约 500ms 一次），服务器纯转发 |
| `leave` | `docId` | 离开文档 |

## 服务器 → 客户端

| type | 字段 | 说明 |
|---|---|---|
| `snapshot` | `docId`, `revision`, `content`, `clientId`, `clients[]` | 加入成功。`clientId` 是分配给本连接的 id，`clients` 是已在线的其他人 |
| `ack` | `docId`, `revision` | 你提交的操作已被接受，`revision` 是它成为的新版本号 |
| `op` | `docId`, `revision`, `op`, `author` | 别人的操作，已由服务器转换到 `revision - 1` 版之上 |
| `cursor` | `docId`, `author`, `cursor` | 别人的光标 |
| `typing` | `docId`, `author` | 某人正在输入（心跳，客户端超时约 2s 自动隐藏） |
| `joined` | `docId`, `client:{clientId, name}` | 有人加入 |
| `left` | `docId`, `clientId` | 有人离开 |
| `deleted` | `docId` | 文档被 REST 删除。收到后应跳回文档列表 |
| `error` | `message` | 出错。客户端收到后应重新 `join` 拉取全量恢复 |

## 文档管理 REST

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/docs` | 文档列表 |
| `POST` | `/api/docs` | 创建，body `{title, content}` |
| `GET` | `/api/docs/{id}` | 文档元信息 |
| `PATCH` | `/api/docs/{id}` | 重命名，body `{title}` |
| `DELETE` | `/api/docs/{id}` | 删除（在线房间会收到 `deleted` 广播） |
| `GET` | `/api/docs/{id}/replay` | 时光回放：`{baseContent, baseRevision, operations:[{revision, author, op, createdAt}]}`。客户端从快照正向重放得到每一版，配合倒序 invert 可回溯到第 0 版 |

## 版本号约定

- `revision` = 服务器已接受的操作数量。初始内容是第 0 版，应用第 1 个操作后是第 1 版。
- 客户端同一时刻最多只有一个操作在途（等 `ack`）。等待期间的本地编辑合并进 buffer，收到 `ack` 后再发。
- 服务器收到基于第 r 版的操作时，依次与第 r 版之后的每个历史操作做 transform，再应用、持久化、广播。
- **定序保证**：服务器把同一文档的「转换 → 持久化 → ack → 广播」整体串行（按文档加锁），
  快照的读取与进房也是原子的。因此每个客户端连接收到的消息（自己的 `ack`、别人的 `op`）
  revision 严格按 1, 2, 3… 连续递增，每个 revision 恰好一条消息，且 `snapshot` 一定先于后续 `op`。
- **客户端校验**：客户端不盲信定序保证，按消息里的 revision 三查——落后的丢弃（重复投递）、
  超前的缓冲（等中间版本补齐后按序处理）、恰好是下一版的才交给 OT 状态机。
  `ack` 与 `op` 走同一条校验通道（见 `packages/sync/src/otClient.ts`）。

## transform 参数顺序约定

同一位置同时插入时，`transform(a, b)` 让 a 的内容排在 b 前面。为保证所有节点结果一致：

- 服务器：`transform(刚收到的客户端操作, 历史操作)`
- 客户端：`transform(本地未确认操作, 服务器广播的操作)`

## 一次完整交互示例

```
C1 → S   {"type":"join","docId":"d1","name":"Alice"}
S  → C1  {"type":"snapshot","docId":"d1","revision":0,"content":"chat","clientId":"c-1a2b","clients":[]}
C2 → S   {"type":"join","docId":"d1","name":"Bob"}
S  → C2  {"type":"snapshot","docId":"d1","revision":0,"content":"chat","clientId":"c-3c4d","clients":[{"clientId":"c-1a2b","name":"Alice"}]}
S  → C1  {"type":"joined","docId":"d1","client":{"clientId":"c-3c4d","name":"Bob"}}

C1 → S   {"type":"op","docId":"d1","revision":0,"op":[1,-1,2]}        Alice 删 h
C2 → S   {"type":"op","docId":"d1","revision":0,"op":[4,"s"]}         Bob 同时加 s（也基于第 0 版）
S  → C1  {"type":"ack","docId":"d1","revision":1}
S  → C2  {"type":"op","docId":"d1","revision":1,"op":[1,-1,2],"author":"c-1a2b"}
S  → C2  {"type":"ack","docId":"d1","revision":2}
S  → C1  {"type":"op","docId":"d1","revision":2,"op":[3,"s"],"author":"c-3c4d"}   已转换：4 → 3
```

最终双方内容都是 `cats`。

# lonelycat-client

LonelyCat 协同编辑客户端。TypeScript，网页和桌面（Electron）共用同一份代码。

## 结构

| 包 | 说明 |
|---|---|
| `packages/ot-core` | 纯 TS 的 OT 算法库，与后端 Java `ot-core` 一一对应，共用同一份测试向量 |
| `packages/sync` | 同步层：`OtClient` 三状态机 + `OtSyncAdapter`（WebSocket）。编辑器只依赖 `SyncAdapter` 接口，以后换 CRDT 只替换实现 |
| `packages/editor` | CodeMirror 6 桥接：本地改动转操作、远端操作应用、远端光标显示 |
| `apps/web` | Vite 网页壳：文档列表 + 编辑页 |
| `apps/desktop` | Electron 壳，加载 `apps/web` 的构建产物 |

## 运行

先启动后端（`lonelycat-server`，默认 9090 端口）。

```bash
npm install
npm test                # ot-core 和 sync 的单元测试
npm run dev:web         # 网页，http://localhost:5173
```

桌面端（开发模式，需要 dev:web 已在运行）：

```bash
npm run dev:desktop
```

桌面端（正式模式，加载构建产物）：

```bash
npm run build:web
npm run start -w @lonelycat/desktop
```

后端地址默认 `http://localhost:9090`，改成别的机器：在 `apps/web/.env.local` 里写 `VITE_SERVER_URL=http://192.168.1.10:9090`。

## 代码导读

按数据流向阅读：

1. `packages/ot-core/src/textOperation.ts` 操作结构和 `apply`
2. `packages/ot-core/src/otEngine.ts` `compose` / `transform` / `transformCursor`
3. `packages/sync/src/otClient.ts` 客户端三状态机（Synchronized / AwaitingConfirm / AwaitingWithBuffer）
4. `packages/sync/src/otSyncAdapter.ts` WebSocket 收发、重连、把消息喂给状态机
5. `packages/editor/src/collab.ts` CodeMirror 事务 ↔ 操作的转换
6. `packages/editor/src/remoteCursors.ts` 远端光标绘制
7. `apps/web/src/main.ts` 页面和路由

## 与后端的契约

- 协议：`lonelycat-server/PROTOCOL.md`
- 测试向量：`packages/ot-core/test/ot-test-vectors.json` 与 `lonelycat-server/ot-core/src/test/resources/ot-test-vectors.json` 必须保持一致

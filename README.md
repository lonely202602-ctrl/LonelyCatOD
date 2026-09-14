# LonelyCatOD

多人在线协同编辑文档。第一版基于 OT（操作转换），后续计划用 CRDT 重做同步层做对比与优化。

| 目录 | 说明 |
|---|---|
| [`lonelycat-server`](lonelycat-server/) | Java 17 + Spring Boot 3 后端，端口 9090。OT 算法库、WebSocket 同步、H2 持久化、REST 接口 |
| [`lonelycat-client`](lonelycat-client/) | TypeScript 前端，网页（Vite + CodeMirror 6）与桌面（Electron）共用一份代码 |

两个项目各自独立构建，之间只通过 [`lonelycat-server/PROTOCOL.md`](lonelycat-server/PROTOCOL.md) 和两份相同的 `ot-test-vectors.json` 约定契约。

## 快速开始

```bash
# 后端
cd lonelycat-server
mvn install
java -jar server-app/target/server-app-0.1.0-SNAPSHOT.jar

# 前端
cd lonelycat-client
npm install
npm run dev:web        # http://localhost:5173
```

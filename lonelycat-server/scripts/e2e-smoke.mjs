// 端到端冒烟测试：用 Node 内置 WebSocket 直连真实后端，复现「chat → cats」场景。
// 运行：node scripts/e2e-smoke.mjs   （需要后端已在 9090 启动，Node >= 22）
//
// 两个客户端都基于第 0 版提交：A 删 h，B 加 s。A 先到，服务器要把 B 的 [4,"s"] 转换成 [3,"s"]。

const SERVER = process.env.SERVER_URL ?? 'http://localhost:9090';
const WS = SERVER.replace(/^http/, 'ws') + '/ws';

async function createDoc() {
  const res = await fetch(`${SERVER}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'e2e-smoke', content: 'chat' }),
  });
  if (!res.ok) throw new Error(`创建文档失败 ${res.status}`);
  return (await res.json()).id;
}

/** 把 WebSocket 包装成「发消息 / 等待某种类型的消息」的小工具 */
function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const queue = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const w = waiters.findIndex((x) => x.type === msg.type);
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
      else queue.push(msg);
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () =>
      resolve({
        name,
        send: (m) => ws.send(JSON.stringify(m)),
        wait: (type, timeoutMs = 3000) =>
          new Promise((res, rej) => {
            const i = queue.findIndex((m) => m.type === type);
            if (i >= 0) return res(queue.splice(i, 1)[0]);
            const t = setTimeout(() => rej(new Error(`${name} 等待 ${type} 超时`)), timeoutMs);
            waiters.push({ type, resolve: (m) => (clearTimeout(t), res(m)) });
          }),
        close: () => ws.close(),
      });
  });
}

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: 期望 ${e}，实际 ${a}`);
  console.log(`  ok  ${label} = ${e}`);
}

const docId = await createDoc();
console.log(`文档 ${docId} 初始内容 "chat"`);

const a = await connect('A');
const b = await connect('B');

a.send({ type: 'join', docId, name: 'Alice' });
const snapA = await a.wait('snapshot');
assertEq(snapA.content, 'chat', 'A 的 snapshot.content');
assertEq(snapA.revision, 0, 'A 的 snapshot.revision');

b.send({ type: 'join', docId, name: 'Bob' });
const snapB = await b.wait('snapshot');
assertEq(snapB.clients.map((c) => c.name), ['Alice'], 'B 看到的在线用户');
const joined = await a.wait('joined');
assertEq(joined.client.name, 'Bob', 'A 收到 joined');

// 两人都基于第 0 版并发提交
a.send({ type: 'op', docId, revision: 0, op: [1, -1, 2] }); // 删 h
const ackA = await a.wait('ack');
assertEq(ackA.revision, 1, 'A 的 ack.revision');

b.send({ type: 'op', docId, revision: 0, op: [4, 's'] }); // 在 t 后加 s，仍基于第 0 版
const ackB = await b.wait('ack');
assertEq(ackB.revision, 2, 'B 的 ack.revision');

// B 会先收到 A 的原始操作
const opFromA = await b.wait('op');
assertEq(opFromA.op, [1, -1, 2], 'B 收到 A 的操作');
// A 收到的是 B 被服务器转换后的操作：4 → 3
const opFromB = await a.wait('op');
assertEq(opFromB.op, [3, 's'], 'A 收到 B 的操作（已转换）');
assertEq(opFromB.revision, 2, '该操作的版本号');

// 第三个人加入，应直接拿到最终内容
const c = await connect('C');
c.send({ type: 'join', docId, name: 'Carol' });
const snapC = await c.wait('snapshot');
assertEq(snapC.content, 'cats', 'C 的 snapshot.content');
assertEq(snapC.revision, 2, 'C 的 snapshot.revision');

// 错误路径：提交一个超前的版本号
c.send({ type: 'op', docId, revision: 99, op: [4] });
const err = await c.wait('error');
console.log(`  ok  超前版本被拒绝: ${err.message}`);

a.close();
b.close();
c.close();
console.log('全部通过');
process.exit(0);

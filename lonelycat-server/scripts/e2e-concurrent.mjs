// 并发端到端测试：3 个写入者同时向同一文档提交操作，1 个被动观察者验证定序。
// 运行：node scripts/e2e-concurrent.mjs   （需要后端已在 9090 启动，Node >= 22）
//
// 验证的核心承诺（修复 broadcast 乱序缺陷后成立）：
//   同一个客户端连接收到的消息（自己的 ack、别人的 op）revision 严格按 1..N 连续递增，
//   每个 revision 恰好一条消息。修复前并发提交时观察者会看到 [2,1,...] 这样的乱序，
//   导致 OT 状态机丢操作、内容永久分歧。
//
// 写入者只做「在第 0 位插入」的操作；内容长度从自己的 ack 和别人的广播 op 里统计
// （连接上消息按 revision 有序，所以发下一条操作前长度必然已经统计完整），
// 因此不需要真正应用操作就能生成合法操作，脚本得以聚焦在「定序」本身。

const SERVER = process.env.SERVER_URL ?? 'http://localhost:9090';
const WS = SERVER.replace(/^http/, 'ws') + '/ws';
const WRITERS = 3;
const OPS_PER_WRITER = 25;
const TOTAL = WRITERS * OPS_PER_WRITER;

async function createDoc() {
  const res = await fetch(`${SERVER}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'e2e-concurrent', content: '' }),
  });
  if (!res.ok) throw new Error(`创建文档失败 ${res.status}`);
  return (await res.json()).id;
}

/** 操作的净插入字符数（本脚本的操作只插入、不删除） */
function insertLength(op) {
  return op.filter((x) => typeof x === 'string').join('').length;
}

/** 把 WebSocket 包装成「发消息 / 等待某种消息 / 捞取已到达消息」的小工具 */
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
        queue,
        wait: (type, timeoutMs = 5000) =>
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
  if (a !== e) throw new Error(`${label}: 期望 ${e}，实际 ${a.slice(0, 200)}`);
  console.log(`  ok  ${label}`);
}

async function until(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('等待超时');
}

const docId = await createDoc();
console.log(`文档 ${docId}，${WRITERS} 个写入者 × ${OPS_PER_WRITER} 个操作，全部并发提交`);

const observer = await connect('观察者');
observer.send({ type: 'join', docId, name: '观察者' });
await observer.wait('snapshot');

const writers = [];
for (let i = 0; i < WRITERS; i++) {
  const w = await connect(`W${i}`);
  w.send({ type: 'join', docId, name: `写入者${i}` });
  await w.wait('snapshot');
  writers.push(w);
}

const t0 = Date.now();

// 每个写入者：循环「在第 0 位插入一段文本 → 等 ack」。同一写入者串行（协议要求最多
// 一个在途操作），写入者之间完全不协调，让服务器的并发路径真实发生。
const failures = [];
const receivedByWriter = writers.map(() => []);
let totalInserted = 0; // 所有被接受操作的实际插入字符数
await Promise.all(
  writers.map(async (w, wi) => {
    const received = receivedByWriter[wi];
    let lastRev = 0;
    let len = 0; // 服务器当前内容长度（初始为空，只增不减）
    for (let k = 0; k < OPS_PER_WRITER; k++) {
      const text = `w${wi}k${k}`;
      // 协议里 0 是非法组件：文档还空着时只有插入、没有 retain
      const op = len > 0 ? [text, len] : [text];
      w.send({ type: 'op', docId, revision: lastRev, op });
      try {
        const ack = await w.wait('ack');
        // 先捞队列里的广播（更早 revision、已按序到达），再记录 ack，保持到达顺序
        for (const m of w.queue.splice(0)) {
          received.push(m);
          if (m.type === 'op') len += insertLength(m.op);
        }
        lastRev = ack.revision;
        received.push({ type: 'ack', revision: ack.revision });
        len += text.length;
        totalInserted += text.length;
      } catch (e) {
        failures.push(`${w.name}: ${e.message}`);
        return;
      }
    }
  }),
);
if (failures.length) throw new Error(`写入失败: ${failures.join('; ')}`);

// 等所有广播送达（每个写入者连接上应收到 TOTAL 条 ack/op，可能还留在 queue 里没归账）
const countMine = (wi) =>
  receivedByWriter[wi].filter((m) => m.type === 'op' || m.type === 'ack').length +
  writers[wi].queue.filter((m) => m.type === 'op' || m.type === 'ack').length;
await until(() => writers.every((_, wi) => countMine(wi) >= TOTAL));
for (const w of writers) {
  const wi = writers.indexOf(w);
  for (const m of w.queue.splice(0)) {
    receivedByWriter[wi].push(m);
  }
}

// 核心断言 1：观察者按到达顺序收到的 op.revision 必须恰好是 1..N 连续递增
const seen = [];
while (seen.length < TOTAL) {
  const msg = await observer.wait('op');
  seen.push(msg.revision);
}
assertEq(seen, Array.from({ length: TOTAL }, (_, i) => i + 1), '观察者收到的广播严格按 revision 定序');

// 核心断言 2：每个写入者连接上，ack 与 op 合起来严格按 1..N 各出现一次
for (let wi = 0; wi < WRITERS; wi++) {
  const w = writers[wi];
  const mine = receivedByWriter[wi].filter((m) => m.type === 'op' || m.type === 'ack');
  assertEq(
    mine.map((m) => m.revision),
    Array.from({ length: TOTAL }, (_, i) => i + 1),
    `${w.name} 连接上的消息按 revision 定序`,
  );
  assertEq(
    mine.filter((m) => m.type === 'ack').length,
    OPS_PER_WRITER,
    `${w.name} 收到的 ack 数量`,
  );
}

// 核心断言 3：所有人重新 join 拿到的最终内容一致，且长度等于所有插入之和
let finalContent = null;
for (const c of [observer, ...writers]) {
  c.send({ type: 'join', docId, name: c.name });
  const snap = await c.wait('snapshot');
  assertEq(snap.revision, TOTAL, `${c.name} 看到的最终版本号`);
  if (finalContent === null) finalContent = snap.content;
  else assertEq(snap.content, finalContent, `${c.name} 与观察者内容一致`);
}
assertEq(finalContent.length, totalInserted, '最终内容长度 = 所有插入之和');

for (const c of [observer, ...writers]) c.close();
console.log(`全部通过（${TOTAL} 个并发操作，耗时 ${Date.now() - t0}ms）`);
process.exit(0);

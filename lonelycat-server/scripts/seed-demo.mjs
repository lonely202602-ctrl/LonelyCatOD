// 生成一篇干净的演示文档：逐行插入一段教学向的介绍文字，
// 每行就是一次提交，回放面板里会得到一段「文档一步步长出来」的动画。
// 运行：node scripts/seed-demo.mjs   （需要后端已在 9090 启动）
//
// 可选参数：node scripts/seed-demo.mjs "自定义标题"

const SERVER = process.env.SERVER_URL ?? 'http://localhost:9090';
const WS = SERVER.replace(/^http/, 'ws') + '/ws';

const title = process.argv[2] ?? 'OT 协同实验场';

const LINES = [
  '# 欢迎来到 LonelyCatOD\n',
  '\n',
  '这是一篇演示文档。在另一个浏览器窗口打开同一篇文档，\n',
  '两边同时打字，就能看到文字和光标实时同步。\n',
  '\n',
  '## 它是怎么做到的？\n',
  '\n',
  '服务端把每一次编辑都记成一条「操作」（Operation）：\n',
  '- retain(n)：跳过前 n 个字符不动\n',
  '- insert(s)：在当前位置插入字符串 s\n',
  '- delete(n)：删掉 n 个字符\n',
  '\n',
  '两人同时编辑时，服务器会对操作做变换（Transform），\n',
  '保证所有人的屏幕最终收敛成同一个结果。\n',
  '\n',
  '## 试一试\n',
  '\n',
  '1. 另开一个窗口加入本文档\n',
  '2. 随便找个位置打几个字\n',
  '3. 点右下角的「🎬 时光回放」，看这篇文档是怎么一步步长出来的\n',
];

async function createDoc() {
  const res = await fetch(`${SERVER}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content: '' }),
  });
  if (!res.ok) throw new Error(`创建文档失败 ${res.status}`);
  return (await res.json()).id;
}

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const queue = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      if (process.env.DEBUG_WS) console.log('<<', ev.data);
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

const docId = await createDoc();
console.log(`文档 ${docId} 「${title}」已创建，开始逐行播种…`);

const c = await connect('Seeder');
c.send({ type: 'join', docId, name: 'Seeder' });
await c.wait('snapshot'); // 加入者自己收到的是 snapshot；joined 只广播给房间里其他人

let revision = 0;
let text = '';
for (const line of LINES) {
  const op = text.length ? [text.length, line] : [line]; // retain 不能是 0，空文档时直接插入
  c.send({ type: 'op', docId, revision, op });
  const ack = await c.wait('ack');
  if (ack.revision !== revision + 1) throw new Error(`版本不连续：期望 ${revision + 1}，收到 ${ack.revision}`);
  revision = ack.revision;
  text += line;
  await new Promise((r) => setTimeout(r, 60)); // 稍微拉开时间，回放时间轴更好看
}

console.log(`播种完成：${LINES.length} 次提交，最终 revision = ${revision}`);
const res = await fetch(`${SERVER}/api/docs/${docId}`);
const doc = await res.json();
console.log(`服务端快照 revision = ${doc.snapshotRevision}`);
c.close();
console.log(`打开 http://localhost:5173/#/doc/${docId} 查看，右下角点「🎬 时光回放」`);

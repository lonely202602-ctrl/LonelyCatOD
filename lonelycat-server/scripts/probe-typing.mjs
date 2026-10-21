// 验证服务端是否转发 typing 消息：两个客户端进同一文档，A 发 typing，B 应收到。
// 用 Node 22 内置 WebSocket，与 e2e 脚本同款。运行：node scripts/probe-typing.mjs <docId>
const docId = process.argv[2];
const url = 'ws://localhost:9090/ws';

const a = new WebSocket(url);
const b = new WebSocket(url);

const log = (...args) => console.log(...args);
let bGotTyping = false;

b.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'typing') {
    bGotTyping = true;
    log('ok  B 收到 typing，author =', msg.author);
  }
  if (msg.type === 'snapshot') log('B joined, rev =', msg.revision);
};

a.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'snapshot') {
    log('A joined, rev =', msg.revision);
    a.send(JSON.stringify({ type: 'typing', docId }));
    setTimeout(() => {
      log(bGotTyping ? '结论: 转发正常' : '结论: 服务端没有把 typing 转发给 B！');
      process.exit(bGotTyping ? 0 : 1);
    }, 800);
  }
};

a.onopen = () => a.send(JSON.stringify({ type: 'join', docId, name: 'typing-a' }));
b.onopen = () => b.send(JSON.stringify({ type: 'join', docId, name: 'typing-b' }));

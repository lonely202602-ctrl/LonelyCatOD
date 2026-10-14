# 从 OT 到 CRDT：原理、问题与替代方案

> 以 LonelyCatOD 为镜的协同编辑技术课。
> 建议边读边对照代码：`lonelycat-client/packages/ot-core`、`packages/sync`、`lonelycat-server/server-app`。
> 读完后你应该能回答三个问题：**为什么人们先用 OT？OT 到底差在哪？为什么 CRDT 能接棒、代价是什么？**

---

## 目录

1. [问题本身：收敛性](#1-问题本身收敛性)
2. [OT：核心思想与经典架构](#2-ot核心思想与经典架构)
3. [为什么人们先用 OT](#3-为什么人们先用-ot)
4. [OT 的问题（按严重程度排序）](#4-ot-的问题按严重程度排序)
5. [CRDT：把"协调"从系统里删掉](#5-crdt把协调从系统里删掉)
6. [CRDT 的代价](#6-crdt-的代价)
7. [对照本项目的学习地图](#7-对照本项目的学习地图)
8. [一个你能亲手做的对比实验](#8-一个你能亲手做的对比实验)
9. [下一步学习路径](#9-下一步学习路径)

---

## 1. 问题本身：收敛性

多人同时编辑一份文档，每个人本地内容都在变，网络有延迟。经典反例（也是本项目 README 和 e2e-smoke 用的例子）：

文档 `chat`，A 删 `h`（操作 `[1,-1,2]`），B 在末尾加 `s`（操作 `[4,"s"]`），都基于第 0 版。
服务器先执行了 A 的，变成 `cat`；此时 B 的「在下标 4 插入」已经失效——`cat` 只有 3 个字符。

要保证的性质叫**收敛（convergence）**：

> 不管操作以什么顺序到达、延迟多久，只要所有人最终收到全部操作，大家的文档内容必然一模一样。

记住这个定义的措辞——第 4 节我们会回头看：**"以什么顺序到达都行"这句话，在 OT 里其实是有前提的**。

---

## 2. OT：核心思想与经典架构

### 2.1 操作表示

一个操作从文档开头走到结尾，由三种组件拼成（网络传输格式）：

| 组件 | 含义 | 例子 |
|---|---|---|
| 正整数 `n` | retain：跳过 n 个字符 | `2` |
| 字符串 `"s"` | insert：插入字符串 | `"s"` |
| 负整数 `-n` | delete：删除 n 个字符 | `-1` |

`chat` 删 `h` 是 `[1, -1, 2]`，末尾加 `s` 是 `[4, "s"]`。核心代码（`packages/ot-core/src/textOperation.ts`，Java 侧 `TextOperation.java` 逐行对应）：

```ts
// 有删节：只保留和理解本文档相关的部分
export class TextOperation {
  readonly ops: OpComponent[] = [];   // 组件列表：正数=retain，负数=delete，字符串=insert
  baseLength = 0;                     // 操作应用前的文档长度
  targetLength = 0;                   // 操作应用后的文档长度

  retain(n: number): this {
    if (n === 0) return this;         // 0 是非法组件，构建时直接吞掉
    this.baseLength += n;
    this.targetLength += n;
    const last = this.ops[this.ops.length - 1];
    if (isRetain(last)) {
      this.ops[this.ops.length - 1] = last + n;   // 相邻同类组件自动合并
    } else {
      this.ops.push(n);
    }
    return this;
  }

  insert(str: string): this { /* targetLength += str.length；相邻 insert 合并；
                                 规范形式：insert 排在紧邻的 delete 前面 */ }

  delete(n: number): this { /* baseLength -= n（存的仍是负数）；相邻合并 */ }

  /** 应用到文档：像尺子一样从头走到尾，逐段“报账” */
  apply(doc: string): string {
    if (doc.length !== this.baseLength) {
      throw new Error(`操作的 baseLength(${this.baseLength}) 与文档长度(${doc.length}) 不一致`);
    }
    const parts: string[] = [];
    let index = 0;
    for (const op of this.ops) {
      if (isRetain(op))      { parts.push(doc.slice(index, index + op)); index += op; }
      else if (isInsert(op)) { parts.push(op); }          // 新内容，不动 index
      else                   { index -= op; }             // delete：跳过被删的段落
    }
    if (index !== doc.length) throw new Error('操作没有覆盖整个文档');
    return parts.join('');
  }
}
```

#### 为什么 `[1, -1, 2]` 结尾有个 `2`？——操作必须覆盖全文

那个 `2` 是 retain 剩下的 2 个字符（`a` 和 `t`），意思是"原样保留，别动"。**一个操作必须把整个文档从头到尾走一遍，每个字符都要有交代**。把它想象成一把尺子从文档开头推到结尾，每遇到一段就声明"这段怎么处理"：

```
文档:  c    h    a    t
操作: [1,  -1,  2]
       │    │    │
      跳过  删掉  原样保留
      'c'  'h'  'at'（2 个字符）
```

所以 `[1, -1, 2]` 完整读出来是：保留 `c`、删除 `h`、保留 `at` → 结果 `cat`。三个组件的绝对值加起来 `1+1+2 = 4`，正好等于文档长度（这就是 `TextOperation` 里 `baseLength` 字段的含义）。

**为什么不写 `2` 不行？** 就是上面 `apply()` 里的第二道检查——组件走完后 `index` 必须恰好等于 `doc.length`，否则：

```ts
if (index !== doc.length) throw new Error('操作没有覆盖整个文档');
```

操作声称作用在长度为 4 的文档上，如果组件加起来只走到 `ch` 就停了，说明它没覆盖全文，直接抛错。这个设计有两个理由：

1. **消除歧义。** 如果允许只写 `[1, -1]`，那它到底是"删 `h` 然后不管后面"还是"删 `h` 和后面所有"？没法定义。强制全文覆盖后，一个操作就是对文档变化的**完整无歧义的说明书**。
2. **transform / compose 靠它对齐。** 这两个算法是"两把尺子并排从左往右对齐推进"（见 2.2），每一步两边各消耗一段。如果一把尺子比另一把短，走到中途就没得对齐了。

反过来也能读懂另一个例子：`chat` 末尾加 `s` 是 `[4, "s"]`——先把 4 个字符全跳过，再插入。若一个操作什么也不改，就是 `[4]`（纯 retain），叫空操作（`isNoop()`）。

### 2.2 两个核心算法

- **transform(a, b) → [a′, b′]**：a、b 是基于同一版本的并发操作，返回调整后的 a′、b′，满足
  `先做 a 再做 b′ == 先做 b 再做 a′`。这是 OT 的心脏。
- **compose(a, b)**：把连续两个操作合并成一个。客户端等 ack 期间攒 buffer 靠它。

对应代码：`packages/ot-core/src/otEngine.ts` / `OtEngine.java`。两个算法骨架相同：两把"尺子"并排对齐，每次只消耗较短的一段。`transform` 的完整骨架（有删节，四个分支保留两个关键的）：

```ts
export function transform(a: TextOperation, b: TextOperation): [TextOperation, TextOperation] {
  if (a.baseLength !== b.baseLength) {
    throw new Error('transform 要求两个操作 baseLength 相同');   // 并发操作必然基于同一版本
  }
  const aPrime = new TextOperation();
  const bPrime = new TextOperation();
  const c1 = new Cursor(a.ops);          // 尺子一
  const c2 = new Cursor(b.ops);          // 尺子二

  for (;;) {
    if (c1.done() && c2.done()) break;

    // a 插入：a′ 照样插入；b′ 要跳过这段新内容
    if (isInsert(c1.current)) { aPrime.insert(c1.current); bPrime.retain(c1.current.length); c1.next(); continue; }
    // b 插入：对称
    if (isInsert(c2.current)) { aPrime.retain(c2.current.length); bPrime.insert(c2.current); c2.next(); continue; }

    const op1 = c1.current as number;
    const op2 = c2.current as number;

    if (isRetain(op1) && isRetain(op2)) {
      // 两边都跳过同一段：a′、b′ 也都跳过。
      // 只消耗较短的一段，长的那把尺子切掉已处理部分继续比
      if (op1 > op2)          { c1.current = op1 - op2; c2.next(); }
      else if (op1 === op2)   { c1.next(); c2.next(); }
      else                    { c2.current = op2 - op1; c1.next(); }
      aPrime.retain(Math.min(op1, op2));
      bPrime.retain(Math.min(op1, op2));
    } else if (isDelete(op1) && isDelete(op2)) {
      // 两边删同一段：删一次就够，a′、b′ 都不用再删
      if (-op1 > -op2)        { c1.current = op1 - op2; c2.next(); }  // a 删得多，剩尾巴继续对
      else if (op1 === op2)   { c1.next(); c2.next(); }
      else                    { c2.current = op2 - op1; c1.next(); }
    } else if (isDelete(op1) && isRetain(op2)) {
      // a 删、b 保留：a′ 仍要删；b′ 里这段已经不存在（minLen = 较短者）
      /* ...逐段消耗... */ aPrime.delete(minLen);
    } else if (isRetain(op1) && isDelete(op2)) {
      // 对称：b 删、a 保留
      /* ...逐段消耗... */ bPrime.delete(minLen);
    }
  }
  return [aPrime, bPrime];
}
```

（真实代码里 `Math.min` 那两行是先算 `minLen` 再统一 retain，逻辑一致；`compose` 的骨架相同，只是分支语义换成"合并"。）

#### 例子：两个用户同时删同一个字符，transform 怎么处理

文档还是 `chat`，A 和 B **都基于第 0 版删掉了 `h`**——两人提交了完全相同的操作 `[1, -1, 2]`。这正是"两人删同一个元素"的极端情况。

`transform([1,-1,2], [1,-1,2])` 的尺子对齐过程只有三步：

| 步骤 | a 的当前组件 | b 的当前组件 | 走的分支 | 产出 |
|---|---|---|---|---|
| 1 | retain 1 | retain 1 | 两边都跳过同一段 | a′、b′ 各 retain 1 |
| 2 | **delete 1** | **delete 1** | **两边删同一段：删一次就够** | **什么都不产出** |
| 3 | retain 2 | retain 2 | 两边都跳过 | a′、b′ 各 retain 2 |

结果 a′ 和 b′ 都是 `[3]`（相邻 retain 在构建时合并），恰好就是 2.1 节说的"什么都不改"的空操作。收敛过程：

- **服务器视角**：先应用 A 的 → `cat`（第 1 版）。B 的到达时已落后一版，与历史里的 A 做 transform 得到 `[3]`，应用到 `cat` 还是 `cat`（第 2 版）。
- **客户端 B 视角**：本地早就自己删过 `h`（是 `cat`），收到 A 的广播后 transform，自己未确认的操作和广播都变成 `[3]`，应用后仍是 `cat`。

语义解读一句话：**一个字符只会死一次。** 第二个删除被转换成空操作，两人的意图（"`h` 应该消失"）都完整达成了，两边停在同一个 `cat`。对应上面代码里 delete-delete 分支的注释：*两边删同一段：删一次就够，a′、b′ 都不用再删*——三个 case 分别是 a 删得多（剩个尾巴继续对）、恰好相等（两把尺子一起前进）、b 删得多。如果两人删的区间只是部分重叠，同一个分支同样按"每步只消耗较短的一段"推进，把没被对方删掉的那部分补删进 a′ 或 b′。

顺带分清工角色：这个场景里干活的只有 **transform**（它管"并发操作之间的对账"）。**compose** 管的是另一件事——**同一个用户**连续多次编辑的合并（等 ack 期间新编辑攒进 buffer），跟并发无关。两个算法解决的问题不相交。

### 2.3 经典架构：中心服务器 + 三状态机

本项目原样复刻了 Jupiter（1995）/ ot.js 的架构：

```
客户端                          服务器（唯一裁判）
┌──────────────────┐           ┌────────────────────────┐
│ OtClient 三状态机 │   op(r)   │ DocumentSession        │
│ Synchronized     │ ────────► │  与 baseRev 之后的历史   │
│ AwaitingConfirm  │ ◄──────── │  逐个 transform，应用，  │
│ AwaitingWithBuffer│  ack/op  │  版本号+1，持久化，广播   │
└──────────────────┘           └────────────────────────┘
```

三个关键约束，注意它们**不是实现细节，而是数学正确性的组成部分**：

1. **服务器是唯一的版本号分配者**（`DocumentSession.receive`，锁内串行）。
2. **每个客户端同一时刻最多一个操作在途**（等 ack 期间新编辑攒进 buffer）。
   这保证客户端收到远端操作时，只需要和 outstanding、buffer 各做一次 transform。
3. **同位置同时插入的定序约定**：`transform(a, b)` 让 a 排前面（见 `PROTOCOL.md`）。
   服务器永远把新到操作放第一个参数，客户端永远把本地未确认操作放第一个参数——约定一旦两端不一致，同位置并发插入就会发散。

第 2 条约束落到代码上是整个状态机的心脏——`AwaitingConfirm` 状态收到远端操作（`otClient.ts`）：

```ts
// 收到的 op 基于「服务器版本」，本地文档比服务器多一个未确认的 outstanding：
// 要把 op 转换成 op′ 才能应用到本地；outstanding 也要换成 outstanding′，
// 因为等它到达服务器时，服务器会做同样的转换。
applyServer(client: OtClient, op: TextOperation): ClientState {
  const [outstandingPrime, opPrime] = transform(this.outstanding, op);
  client.applyOperation(opPrime);                 // op′ 应用到本地编辑器
  return new AwaitingConfirm(outstandingPrime);   // outstanding 悄悄换成 outstanding′
}
```

（`AwaitingWithBuffer` 状态是它的两步版：先过 outstanding、再过 buffer。）

**请记住 2.3 这一小节**，第 4 节要回来收账。

---

## 3. 为什么人们先用 OT

### 3.1 时间线：OT 早了 CRDT 二十多年

| 年份 | 事件 |
|---|---|
| 1989 | Ellis & Gibbs 的 GROVE，首次提出操作转换（dOPT） |
| 1995 | Jupiter：客户端-服务器状态机架构（本项目 OtClient 的直系祖先） |
| 2006 | Google 收购 Writely，后改名 Google Docs，内部用 OT |
| 2009 | Google Wave 发布，OT 的工业化巅峰（Wave 工程师 Joseph Gentle 后来写了 ot.js） |
| 2011 | Shapiro 等人证明 CRDT 收敛性定理（Strong Eventual Consistency） |
| 2006–2016 | WOOT / RGA / Logoot / YATA（Yjs 的算法）等文本 CRDT 逐渐成熟 |
| 2019 | Ink & Switch 发表《Local-first software》，CRDT 成为去中心化协作的代名词 |

做协同编辑时，OT 不是"比较后的胜出"，而是**当时唯一成熟的选择**。CRDT 有理论可用已经是 2011 年之后的事。

### 3.2 三个让它成为默认选择的原因

**① 直觉友好。** 冲突被建模成"位置错位"，解法就是"修正位置"。`[4,"s"]` 在删除之后到达？左移一位变 `[3,"s"]`。人类一眼就能看懂、能手推正确性，这对一个新领域至关重要。

**② 中心服务器是 Web 时代的自然假设。** 产品本来就跑在机房里，让服务器当唯一裁判、按序编号， OT 就只需要处理"二元转换"（TP1），数学上大大简化。没人当时觉得"必须去中心化"——浏览器离线编辑在 2006 年是科幻。

**③ 操作即意图，天然附带好东西。** OT 记录的是"用户做了什么"：操作日志就是编辑历史（undo 靠 `invert`，本项目 `textOperation.ts` 里有）、就是审计记录、就是"回放"素材。操作也很小（相对于全文快照）。

---

## 4. OT 的问题（按严重程度排序）

先纠正一个常见误解：**"OT 的缺陷是算力消耗大"——算力是真实的，但排在最后一位**。真正让业界转向 CRDT 的，是下面前三个。

### 4.1 ① 正确性极其脆弱：TP1 与 TP2

transform 函数必须满足两条性质：

- **TP1（收敛）**：`transform(a, b)` 产生的 a′、b′ 满足 `apply(apply(S,a), b′) == apply(apply(S,b), a′)`。
  二元转换，好办，随机测试就能兜住（本项目 `random.test.ts` / `RandomConvergenceTest.java` 干的就是这个）。
- **TP2（与转换路径无关）**：三个并发操作 a、b、c，`transform(a, c)` 的结果是否取决于"先对 b 转换过没有"。
  **TP2 被证明极难满足。** 学术界发表过的 transform 函数，后来被形式化方法找出反例的比比皆是（WOOT 论文里整理过一批）；Google Wave 的 OT 复杂到没人能完整证明其正确性，而且它干脆**不满足 TP2**，靠中心服务器串行化绕过去了。

本项目的对策同样是"绕"：**中心服务器 + 单在途操作约束**（2.3 节那三条），把问题限制在 TP1 就够的范围内。这是 ot.js/Jupiter 的经典取舍——不是解决 TP2，而是设计出一个永远遇不到 TP2 的系统。

代价是：这三条约束成了系统的"承重墙"，谁碰谁塌。下面②就是活例子。

### 4.2 ② 收敛性的前提是单点串行定序——本项目 P0 竞态就是活教材

**OT 的收敛性不是 `transform` 一个函数给的，而是"transform 函数 + 服务器串行定序 + 客户端单在途约束"整套协议一起给的。** 其中任何一环松动，收敛就塌，而且塌得几乎无声。

2026-09-15 本项目修掉的 P0 竞态就是最好的注脚：

- `DocumentSession.receive` 的锁只覆盖版本号分配，**落库、ack、广播都在锁外**；
- 两个线程拿到 rev=1、rev=2 之后，广播顺序颠倒了（实测 `[2,1]`）；
- 客户端状态机默认"远端操作按 revision 顺序到达"（otClient.ts 旧注释原话），收到超前版本直接应用 → 长度不匹配 → 丢弃 → **无声的永久分歧**。

修复本身没动任何算法。服务端一层，把"转换→持久化→ack→广播"整体放进按文档的锁（`CollabWebSocketHandler.onOperation`）：

```java
// 修复前：只有 receive 内部有锁，落库/ack/广播裸奔在锁外，两个线程可以颠倒广播顺序
// 修复后：整段串行（@Transactional 的提交发生在 applyOperation 返回前，也在锁内）
synchronized (docSession) {
    DocumentSession.Applied applied =
            documentService.applyOperation(docSession, op, msg.revision, client.clientId);
    // ...装 ack 消息...
    send(client, ack);
    // ...装广播消息...
    broadcast(rooms.getOrDefault(client.docId, Set.of()), broadcastMsg, client);
}
```

客户端一层，ack 和 op 走同一条 revision 校验通道，不盲信服务器的定序承诺（`otClient.ts`）：

```ts
private receiveRemote(revision: number, event: PendingRemote): void {
  if (revision <= this.revision) {
    return;                              // 重复或过期：丢弃
  }
  if (revision > this.revision + 1) {
    this.pending.set(revision, event);   // 中间版本还没到：先缓冲
    return;
  }
  this.acceptRemote(event);              // 恰好是下一版：交给状态机
  this.drainPending();                   // 再看缓冲里有没有排队的，逐个放行直到断档
}
```

修复配了一个"可红可绿"的回归测试：把 `synchronized` 摘掉，测试立刻报 `expected [1,2] but was [2,1]`；恢复后变绿。但这暴露了 OT 的结构性事实：

> **OT 系统里必须存在一个（或逻辑上的）单点，把所有操作定成全序。** 单实例好办；多实例要引入按文档的会话粘性或分布式定序；P2P 场景下，这个"单点"根本不存在，OT 的经典数学直接失效。

这正是 1 节结尾埋的伏笔："不管以什么顺序到达都收敛"在 OT 里从来不是免费的，它靠串行化买回来的。

### 4.3 ③ 历史保留与离线：延迟越大，OT 越难看

服务器收到基于第 r 版的操作时，要和第 r 版之后的**每一个**历史操作做链式 transform。这段就是 `DocumentSession.receive` 的核心（Java）：

```java
// 客户端基于第 baseRev 版生成操作，但服务器已经到了第 revision 版：
// 中间的每一个并发操作都要和它做一次 transform，把它“搬”到最新版本上
TextOperation transformed = op;
for (int r = baseRev; r < revision; r++) {
    TextOperation concurrent = history.get(r - historyStartRevision);
    transformed = OtEngine.transform(transformed, concurrent).aPrime();
}
if (transformed.getBaseLength() != content.length()) {
    throw new IllegalArgumentException("操作长度与文档长度不一致");   // 校验失败 → 客户端重新 join
}
content = transformed.apply(content);
history.add(transformed);   // 进历史：后续更落后的客户端还要拿它做 transform
revision++;
```

推论：

- **服务器必须保留历史**。本项目 `historyStartRevision` 之前的操作丢了就直接拒绝客户端（"太旧，请重新加入"）。历史不能无限留，客户端随时可能基于任意老版本提交——这个矛盾没有优雅解。
- **离线编辑是 OT 的天敌。** 离线一小时攒了几百个操作，重连时它们基于一个超老版本，要和海量历史做长链 transform；而且"单在途操作"约束在离线状态下根本无法维持（永远收不到 ack）。本项目 README"已知限制"里写的"断线重连丢未确认操作"，就是这套约束的让步。

### 4.4 ④ 算力：真实，但次要

每个到达操作 transform O(自 baseRev 以来的历史长度)，高峰期服务器纯做字符串手术，Google Wave 团队确实为此抱怨过成本。但要客观：

- 这是"贵"，不是"错"；前三个才是"错"。
- 有成熟缓解（缓存、定期快照截断历史——本项目 `snapshotInterval` 就是个雏形）。
- **"OT 慢、CRDT 快"是个粗糙的简化**：CRDT 有自己的常数开销（见第 6 节）。集中式场景下 OT 至今够用——Google Docs 公开资料里用的仍是 OT。

---

## 5. CRDT：把"协调"从系统里删掉

### 5.1 核心定理：不协调，也能收敛

Shapiro 等人 2011 年证明（Strong Eventual Consistency）：

> 只要每个副本上的**合并操作满足交换律**（准确说：状态构成 join-semilattice，合并 = 求上确界），那么**各副本不需要任何协调、不需要全局定序**，只要最终收到相同的操作/状态集合，内容必然相同。

对比一下：

| | OT | CRDT |
|---|---|---|
| 正确性来源 | transform 函数 + 服务器串行定序 + 客户端单在途约束（**协议三件套**） | **数据结构本身**（合并可交换） |
| 对到达顺序 | 敏感（P0 竞态就是证据） | 完全不敏感 |
| 需要单点裁判 | 是 | 否 |

### 5.2 实现路径：给每个字符一个身份证

文本 CRDT（以 RGA 为例）的做法：

1. 每个字符有全局唯一 ID，例如 `(本地计数器, 副本ID)`；
2. 插入不再是"在下标 4 插入"，而是"**在 ID 为 X 的字符后面**插入 ID 为 Y 的字符"——位置用引用表达，不用数字下标；
3. 两个人在同一个位置并发插入？**按 ID 大小排出确定顺序**（比如 ID 大的排前面）。

于是合并 = 把两边见过的字符集合取并集，再按固定规则排序。两个副本以任何顺序收到相同的操作集，各自重放**同一个确定性排序函数**，结果必然相同——收敛性从"协议遵守"变成了"数据结构的数学性质"。

这就是那句精辟的总结：**CRDT 用数据结构的复杂度，换掉了系统的协调复杂度。**

> 注意 2.3 节的定序约定：OT 里"谁排前面"是实现之间必须人工对齐的**约定**（本项目靠 PROTOCOL.md 和共享测试向量保障）；CRDT 里它是数据自带的**性质**。同位置并发插入的"谁在前"问题两者都没有消失（见第 6 节），但 CRDT 不可能因为约定没对齐而发散。

### 5.3 收益逐条对照 OT 的痛点

| OT 的痛点 | CRDT 的回答 |
|---|---|
| 依赖单点串行定序（P0 的根因） | 不需要任何定序；服务器退化为**中转站 + 存储** |
| TP2 正确性脆弱 | 收敛由定理保证，实现层面只需保证合并可交换 |
| 服务器必须保留操作历史 | 不需要 transform 历史，状态直接 merge |
| 离线 / 高延迟退化严重 | 离线随便编，重连时 update 集合 merge 即可，与顺序无关 |
| 多实例 / P2P 需要 extra 工程 | 天然支持（本来的设计目标） |

对本项目最直观的一点：**做 Yjs 版时，`OtClient` 三状态机会整个消失**——Yjs 内部自己管理合并，客户端不再有 outstanding/buffer 概念；服务端从"OT 裁判"退化成"不透明 update 字节流的中转 + 存储"。

---

## 6. CRDT 的代价

不诚实讲代价就是传教，不是上课：

1. **元数据开销。** 每个字符带 ID，删除的字符留"墓碑"（别人可能还没见过它）。Yjs 用紧凑二进制编码、把已删内容本身回收（只留标记）压得很好，但仍是实打实的内存/流量常数开销。OT 的操作日志没有这个负担。
2. **tie-break 语义不合直觉。** 两人在同一个位置并发打字，收敛没问题，但"谁在前"由 ID 大小决定，**可能不符合任何人的预期**。OT 的同位置约定有同样的问题——这不是 CRDT 独有，但 CRDT 的顺序由数据决定，应用层更难干预。
3. **服务器不理解内容了。** update 是不透明字节，服务端做权限校验、内容审核、按行检索都变难。OT 时代服务器看得懂每个操作。这是做鉴权（README 路线图第 2 项）时要想清楚的。
4. **理解成本更高。** "transform 两个操作"能手推，RGA/YATA 的正确性论证更抽象。CRDT 圈还有句行话："CRDTs: The Hard Parts"（Kleppmann 的同名演讲值得看）——收敛性免费了，但语义、GC、性能每个都有坑。

一句话总结选型：

> **有可信中心服务器、只做在线协作 → OT 依然合理（Google Docs 就是证据）；要离线、多端、去中心、水平扩展 → CRDT 几乎是唯一解。** 本项目两个都做一遍，正是为了把这句话变成自己的经验而不是背书。

---

## 7. 对照本项目的学习地图

| 项目里的位置 | 它是什么概念的化身 | 换 CRDT 后的命运 |
|---|---|---|
| `DocumentSession.receive` 的 `synchronized` | OT 的"单点串行定序"假设（P0 竞态 = 假设被自己的并发破坏） | **消失**。Yjs 中转服务器不需要锁 |
| `OtClient` 三状态机（Synchronized / AwaitingConfirm / AwaitingWithBuffer） | Jupiter 架构；为让 transform 数学可控付出的交互约束 | **整个消失**。Yjs 自己管理合并 |
| `historyStartRevision` 拒绝太旧客户端 | OT 必须保留历史的直接后果 | 消失。update 集合 merge，与版本无关 |
| `transform(a,b)` 的 a-在前约定 | TP1 级别的定序约定，靠文档+共享测试向量对齐两端 | 变成数据自带的 tie-break（ID 排序） |
| `changesToOperation` / `operationToChanges`（editor 包） | 操作 ↔ 编辑器事务的桥 | 几乎不动（换成 yjs 的 y-codemirror 桥） |
| `SyncAdapter` 接口 | 预留的替换边界 | **替换点本身**：`OtSyncAdapter` → `YjsSyncAdapter`，编辑器层不动 |

## 8. 一个你能亲手做的对比实验

修完 P0 之后，项目里多了 `scripts/e2e-concurrent.mjs`：3 个写入者真并发提交 75 个操作，观察者验证服务器广播严格按 revision 定序、最终内容一致。

- **OT 版**：这个测试通过的前提，是 `onOperation` 里那把 `synchronized(docSession)`——没有它测试立刻变红（我验证过：摘掉修复，广播顺序实测变 `[2,1]`）。
- **将来 CRDT 版**：写完 `YjsSyncAdapter` + 服务端 update 中转后，**用同一个脚本再跑一遍**。服务器一行锁都不用加，甚至故意把 update 乱序投递，客户端照样收敛。

同一个测试、两种架构、一把锁的有无——这就是"OT 靠协调、CRDT 靠数据"最具体的体感。

## 9. 下一步学习路径

按建议顺序：

1. **《Local-first software》**（Ink & Switch, Kleppmann et al., 2019）——为什么"离线优先 + 去中心"值得做，CRDT 的产品视角宣言。读它之前你学的 OT 就是最好的对照组。
2. **Yjs 官方文档**（docs.yjs.dev）—— `Y.Doc` / update / provider 三个概念就够起步；动手写 `YjsSyncAdapter` 时你会发现它和 `OtSyncAdapter` 的事件接口惊人地同构。
3. **《Conflict-free Replicated Data Types》**（Shapiro et al., 2011）——定理原文，第 5.1 节的严格版本。只读前半（state-based / op-based、semilattice）即可。
4. **WOOT 论文**（Oster et al., 2006）——第一个为文本设计的 CRDT，引言里对 OT 的 TP2 困境的批评写得最好。
5. **《CRDTs: The Hard Parts》**（Martin Kleppmann 的演讲，2020）——诚实讲 CRDT 的难处，对应第 6 节的展开。
6. Joseph Gentle（ex-Google Wave、ot.js 作者）的博客——OT 阵营老兵对 OT 复杂度的第一手反思，和本项目的三状态机互为印证。

---

*本文由 G 老师写于 2026-09-15，P0 定序修复完成之后。文中所有代码引用以当天的仓库状态为准。*

import { describe, expect, it } from 'vitest';
import { CrdtDoc, type CrdtOpJson } from './crdtDoc';

/** 把一组操作按顺序灌进副本 */
function applyAll(doc: CrdtDoc, ops: CrdtOpJson[]) {
  for (const op of ops) doc.applyRemote(op);
}

describe('CrdtDoc（RGA 教学版）', () => {
  it('并发同位置插入：两个副本不同接收顺序，文本一致', () => {
    const a = new CrdtDoc('siteA');
    const b = new CrdtDoc('siteB');
    const opsA = a.localReplace(0, 0, 'hello');
    const opsB = b.localReplace(0, 0, 'world');

    const c1 = new CrdtDoc('c1');
    const c2 = new CrdtDoc('c2');
    // 交叉顺序 A1 B1 A2 B2 …
    for (let i = 0; i < 5; i++) {
      c1.applyRemote(opsA[i]);
      c1.applyRemote(opsB[i]);
    }
    // 成组顺序：先 A 全部再 B 全部
    applyAll(c2, opsA);
    applyAll(c2, opsB);

    expect(c1.text).toBe(c2.text);
    expect(c1.text).toHaveLength(10);
  });

  it('接力编辑：B 接着 A 的末尾打字，操作传回去双方一致', () => {
    const a = new CrdtDoc('siteA');
    const b = new CrdtDoc('siteB');
    applyAll(b, a.localReplace(0, 0, 'ab'));
    expect(b.text).toBe('ab');

    applyAll(a, b.localReplace(2, 0, 'cd'));
    expect(a.text).toBe('abcd');
    expect(b.text).toBe('abcd');
  });

  it('删除打墓碑：两边一致，且在墓碑处继续插入不冲突', () => {
    const a = new CrdtDoc('siteA');
    const b = new CrdtDoc('siteB');
    applyAll(b, a.localReplace(0, 0, 'abc'));

    applyAll(b, a.localReplace(1, 1, '')); // 删 b
    expect(a.text).toBe('ac');
    expect(b.text).toBe('ac');

    applyAll(b, a.localReplace(1, 0, 'X')); // 墓碑处插入
    expect(a.text).toBe('aXc');
    expect(b.text).toBe('aXc');
  });

  it('重复投递幂等', () => {
    const doc = new CrdtDoc('siteA');
    const ops = doc.localReplace(0, 0, 'hi');
    doc.applyRemote(ops[0]);
    doc.applyRemote(ops[0]);
    expect(doc.length).toBe(2);
  });

  it('副本状态整体搬家：文本和墓碑结构都一致', () => {
    const a = new CrdtDoc('siteA');
    a.localReplace(0, 0, 'hello');
    a.localReplace(1, 1, 'E'); // 留一个墓碑

    const b = new CrdtDoc('siteB');
    b.loadState(a.stateToJson());
    expect(b.text).toBe(a.text);
    expect(b.entriesSnapshot.length).toBe(a.entriesSnapshot.length);
  });

  it('三个站点并发编辑 + 事后删除，不同批次顺序到达仍收敛', () => {
    // 三个站点各在空文档上并发打字（各自只见过自己的操作）
    const s1 = new CrdtDoc('s1');
    const s2 = new CrdtDoc('s2');
    const s3 = new CrdtDoc('s3');
    const batch1 = s1.localReplace(0, 0, '一二三');
    const batch2 = s2.localReplace(0, 0, 'ABC');
    const batch3 = s3.localReplace(0, 0, 'xy');
    // s1 收齐 batch2、batch3 之后删一个字（因果上必须在 batch2/3 之后应用）
    applyAll(s1, batch2);
    applyAll(s1, batch3);
    const batch4 = s1.localReplace(5, 1, ''); // 删"一"

    const views = [new CrdtDoc('v1'), new CrdtDoc('v2'), new CrdtDoc('v3')];
    // batch4 因果上依赖前三个批次（删的是见过的字符），只能在它们之后；前三个任意排列
    const orders: CrdtOpJson[][][] = [
      [batch1, batch2, batch3, batch4],
      [batch2, batch3, batch1, batch4],
      [batch3, batch1, batch2, batch4],
    ];
    for (const [vi, order] of orders.entries()) {
      for (const batch of order) applyAll(views[vi], batch);
    }

    expect(views[0].text).toBe(views[1].text);
    expect(views[1].text).toBe(views[2].text);
    expect(views[0].text).toContain('xy');
    expect(views[0].text).not.toContain('一');
  });
});

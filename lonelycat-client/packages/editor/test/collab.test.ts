import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { TextOperation } from '@lonelycat/ot-core';
import { changesToOperation, operationToChanges } from '../src/collab';

/**
 * 验证 CodeMirror 事务 ↔ TextOperation 的互转。
 * EditorState 不依赖 DOM，可以在 Node 里直接构造事务来测。
 */

// 固定种子伪随机
let seed = 7;
const rand = (n: number) => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed % n;
};
const randomText = (max: number) =>
  Array.from({ length: rand(max + 1) }, () => 'abc 中文\n'[rand(8)]).join('');

function randomOperation(doc: string): TextOperation {
  const op = new TextOperation();
  let remaining = doc.length;
  while (remaining > 0 || rand(4) === 0) {
    let choice = rand(3);
    if (remaining === 0) choice = 1;
    if (choice === 0) {
      const n = 1 + rand(remaining);
      op.retain(n);
      remaining -= n;
    } else if (choice === 1) {
      op.insert(randomText(3) || 'x');
    } else {
      const n = 1 + rand(remaining);
      op.delete(n);
      remaining -= n;
    }
    if (remaining === 0 && rand(3) !== 0) break;
  }
  return op;
}

describe('operationToChanges', () => {
  it('经典例子：删 h 和末尾加 s', () => {
    const state = EditorState.create({ doc: 'chat' });
    const tr1 = state.update({ changes: operationToChanges(TextOperation.fromJSON([1, -1, 2])) });
    expect(tr1.state.doc.toString()).toBe('cat');
    const tr2 = state.update({ changes: operationToChanges(TextOperation.fromJSON([4, 's'])) });
    expect(tr2.state.doc.toString()).toBe('chats');
  });

  it('随机操作经 CodeMirror 应用的结果与 op.apply 一致', () => {
    for (let i = 0; i < 300; i++) {
      const doc = randomText(20);
      const op = randomOperation(doc);
      const state = EditorState.create({ doc });
      const tr = state.update({ changes: operationToChanges(op) });
      expect(tr.state.doc.toString()).toBe(op.apply(doc));
    }
  });
});

describe('changesToOperation', () => {
  it('用户在中间输入一个词', () => {
    const state = EditorState.create({ doc: 'hello world' });
    const tr = state.update({ changes: { from: 6, insert: 'big ' } });
    const op = changesToOperation(tr);
    expect(op.toJSON()).toEqual([6, 'big ', 5]);
  });

  it('用户选中一段替换', () => {
    const state = EditorState.create({ doc: 'hello world' });
    const tr = state.update({ changes: { from: 0, to: 5, insert: 'bye' } });
    expect(changesToOperation(tr).toJSON()).toEqual(['bye', -5, 6]);
  });

  it('多段同时修改（例如多光标）', () => {
    const state = EditorState.create({ doc: 'aaa bbb ccc' });
    const tr = state.update({
      changes: [
        { from: 0, to: 3, insert: 'A' },
        { from: 8, to: 11, insert: 'C' },
      ],
    });
    const op = changesToOperation(tr);
    expect(op.apply('aaa bbb ccc')).toBe('A bbb C');
  });

  it('随机往返：op → changes → op 语义不变', () => {
    for (let i = 0; i < 300; i++) {
      const doc = randomText(20);
      const op = randomOperation(doc);
      const state = EditorState.create({ doc });
      const tr = state.update({ changes: operationToChanges(op) });
      const back = changesToOperation(tr);
      expect(back.apply(doc)).toBe(op.apply(doc));
      expect(back.baseLength).toBe(doc.length);
    }
  });
});

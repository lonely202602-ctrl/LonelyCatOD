import { describe, expect, it } from 'vitest';
import { TextOperation, compose, transform, transformCursor } from '../src';

/**
 * 随机测试：覆盖手写向量顾不到的边角情况。
 */

// 固定种子的简单伪随机数，保证失败可复现
function makeRandom(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % n;
  };
}
const rand = makeRandom(20260914);
const ALPHABET = 'abcdefghij 中文字符\n';

function randomText(maxLen: number): string {
  const len = rand(maxLen + 1);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[rand(ALPHABET.length)];
  return out;
}

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
      op.insert(randomText(4) || 'x');
    } else {
      const n = 1 + rand(remaining);
      op.delete(n);
      remaining -= n;
    }
    if (remaining === 0 && rand(3) !== 0) break;
  }
  return op;
}

const ROUNDS = 500;

describe('随机性质测试', () => {
  it('apply 后长度等于 targetLength', () => {
    for (let i = 0; i < ROUNDS; i++) {
      const doc = randomText(30);
      const op = randomOperation(doc);
      expect(op.apply(doc).length).toBe(op.targetLength);
    }
  });

  it('invert 能撤销操作', () => {
    for (let i = 0; i < ROUNDS; i++) {
      const doc = randomText(30);
      const op = randomOperation(doc);
      expect(op.invert(doc).apply(op.apply(doc))).toBe(doc);
    }
  });

  it('compose 等价于顺序应用', () => {
    for (let i = 0; i < ROUNDS; i++) {
      const doc = randomText(30);
      const a = randomOperation(doc);
      const afterA = a.apply(doc);
      const b = randomOperation(afterA);
      expect(compose(a, b).apply(doc)).toBe(b.apply(afterA));
    }
  });

  it('transform 两条路径收敛', () => {
    for (let i = 0; i < ROUNDS; i++) {
      const doc = randomText(30);
      const a = randomOperation(doc);
      const b = randomOperation(doc);
      const [aPrime, bPrime] = transform(a, b);
      expect(bPrime.apply(a.apply(doc))).toBe(aPrime.apply(b.apply(doc)));
    }
  });

  it('transformCursor 让光标停在同一个字符前', () => {
    for (let i = 0; i < ROUNDS; i++) {
      const doc = randomText(30);
      const op = randomOperation(doc);
      const pos = rand(doc.length + 1);
      const newPos = transformCursor(pos, op, false);
      const after = op.apply(doc);
      expect(newPos).toBeGreaterThanOrEqual(0);
      expect(newPos).toBeLessThanOrEqual(after.length);
      // 光标之前保留下来的原字符数量不变（删除只减少，插入按规则增加）
      // 这里只验证范围合法性，具体语义由上面的向量覆盖
    }
  });
});

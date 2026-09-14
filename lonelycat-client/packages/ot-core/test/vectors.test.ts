import { describe, expect, it } from 'vitest';
import { TextOperation, compose, transform } from '../src';
import vectors from './ot-test-vectors.json';

/**
 * 与后端共享的测试向量。ot-test-vectors.json 和 lonelycat-server/ot-core 里的是同一份，
 * 两边都跑通才能保证算法行为一致。
 */
type OpJson = (number | string)[];

const op = (json: OpJson) => TextOperation.fromJSON(json);

describe('apply 向量', () => {
  for (const c of vectors.apply as { name: string; doc: string; op: OpJson; expected: string }[]) {
    it(c.name, () => {
      expect(op(c.op).apply(c.doc)).toBe(c.expected);
    });
  }
});

describe('compose 向量', () => {
  for (const c of vectors.compose as {
    name: string;
    doc: string;
    a: OpJson;
    b: OpJson;
    expected: OpJson;
  }[]) {
    it(c.name, () => {
      const a = op(c.a);
      const b = op(c.b);
      const composed = compose(a, b);
      expect(composed.toJSON()).toEqual(op(c.expected).toJSON());
      expect(composed.apply(c.doc)).toBe(b.apply(a.apply(c.doc)));
    });
  }
});

describe('transform 向量', () => {
  for (const c of vectors.transform as {
    name: string;
    doc: string;
    a: OpJson;
    b: OpJson;
    aPrime: OpJson;
    bPrime: OpJson;
    result: string;
  }[]) {
    it(c.name, () => {
      const a = op(c.a);
      const b = op(c.b);
      const [aPrime, bPrime] = transform(a, b);
      expect(aPrime.toJSON()).toEqual(op(c.aPrime).toJSON());
      expect(bPrime.toJSON()).toEqual(op(c.bPrime).toJSON());
      expect(bPrime.apply(a.apply(c.doc))).toBe(c.result);
      expect(aPrime.apply(b.apply(c.doc))).toBe(c.result);
    });
  }
});

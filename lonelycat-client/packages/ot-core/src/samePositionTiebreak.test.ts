import { describe, expect, it } from 'vitest';
import { transform } from './otEngine';
import { TextOperation } from './textOperation';

/**
 * §2.3 约束三（同位置同时插入的定序约定）的回归：
 * 平局由服务器在接受第二条操作时判定——transform(新到, 历史) 让新到的排前面；
 * 此时只有「新到那条」的作者还停在 AwaitingConfirm，他本地重放同一平局时
 * transform(本地未确认, 广播) 也让本地排前面——同一次平局，两端判给同一条操作。
 * 其余客户端收到的是服务器已判好的最终形态，直接应用，根本不会遇到平局。
 */
const op = (...c: (number | string)[]) => TextOperation.fromJSON(c);

describe('同位置并发插入的定序约定', () => {
  it('服务器判的平局，后到者客户端本地重放出同一结果', () => {
    // 文档 "ab"：Alice 在开头插 X，先到，rev1；Bob 并发在开头插 Y，后到，rev2
    const a = op('X', 2);
    const b = op('Y', 2);

    // 服务器：transform(新到 b, 历史 a)，aPrime = b 落到 rev1 文档上的形态
    const [bPrime, aPrime] = transform(b, a);
    const serverDoc = bPrime.apply(a.apply('ab'));

    // Alice（先到者）：ack 已到（Synchronized），直接应用服务器判好的 bPrime
    const aliceDoc = bPrime.apply('Xab');
    expect(aliceDoc).toBe(serverDoc);

    // Bob（后到者）：还在 AwaitingConfirm，先收到 rev1 的广播 a，
    // 本地 transform(本地未确认 b, 广播 a)——本地排前面，和服务器判给同一边
    const [outstandingPrime, aPrimeForBob] = transform(b, a);
    const bobDoc = aPrimeForBob.apply('Yab');
    expect(bobDoc).toBe(serverDoc);
    expect(outstandingPrime.toJSON()).toEqual(bPrime.toJSON()); // 他稍后重发时服务器会得到同一形态
  });
});

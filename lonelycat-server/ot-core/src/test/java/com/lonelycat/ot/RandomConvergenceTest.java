package com.lonelycat.ot;

import org.junit.jupiter.api.RepeatedTest;

import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 随机测试：生成随机文档和随机操作，验证 OT 的两个核心性质在任意输入下都成立。
 * 手写的向量只能覆盖典型场景，这个测试负责覆盖边角情况。
 */
class RandomConvergenceTest {

    private static final Random RANDOM = new Random(20260914L);
    private static final String ALPHABET = "abcdefghij 中文字符\n";

    /** 生成长度随机的文档 */
    private static String randomDoc() {
        int len = RANDOM.nextInt(30);
        StringBuilder sb = new StringBuilder(len);
        for (int i = 0; i < len; i++) {
            sb.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }

    private static String randomText() {
        int len = 1 + RANDOM.nextInt(5);
        StringBuilder sb = new StringBuilder(len);
        for (int i = 0; i < len; i++) {
            sb.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }

    /**
     * 生成一个能作用在 doc 上的随机操作：
     * 从头走到尾，每一步随机选择 retain / insert / delete。
     */
    private static TextOperation randomOperation(String doc) {
        TextOperation op = new TextOperation();
        int remaining = doc.length();
        while (remaining > 0 || RANDOM.nextInt(4) == 0) {
            int choice = RANDOM.nextInt(3);
            if (remaining == 0) {
                choice = 1; // 只剩插入可选
            }
            switch (choice) {
                case 0 -> {
                    int n = 1 + RANDOM.nextInt(remaining);
                    op.retain(n);
                    remaining -= n;
                }
                case 1 -> op.insert(randomText());
                default -> {
                    int n = 1 + RANDOM.nextInt(remaining);
                    op.delete(n);
                    remaining -= n;
                }
            }
            if (remaining == 0 && RANDOM.nextInt(3) != 0) {
                break;
            }
        }
        return op;
    }

    @RepeatedTest(500)
    void applyKeepsLengthConsistent() {
        String doc = randomDoc();
        TextOperation op = randomOperation(doc);
        String result = op.apply(doc);
        assertEquals(op.getTargetLength(), result.length());
    }

    @RepeatedTest(500)
    void invertUndoesOperation() {
        String doc = randomDoc();
        TextOperation op = randomOperation(doc);
        String after = op.apply(doc);
        assertEquals(doc, op.invert(doc).apply(after));
    }

    @RepeatedTest(500)
    void composeEqualsSequentialApply() {
        String doc = randomDoc();
        TextOperation a = randomOperation(doc);
        String afterA = a.apply(doc);
        TextOperation b = randomOperation(afterA);

        TextOperation ab = OtEngine.compose(a, b);
        assertEquals(b.apply(afterA), ab.apply(doc));
    }

    @RepeatedTest(500)
    void transformConverges() {
        String doc = randomDoc();
        TextOperation a = randomOperation(doc);
        TextOperation b = randomOperation(doc);

        OtEngine.TransformResult r = OtEngine.transform(a, b);
        String viaA = r.bPrime().apply(a.apply(doc));
        String viaB = r.aPrime().apply(b.apply(doc));
        assertEquals(viaA, viaB, "transform 没有收敛\n doc=" + doc + "\n a=" + a + "\n b=" + b);
    }
}

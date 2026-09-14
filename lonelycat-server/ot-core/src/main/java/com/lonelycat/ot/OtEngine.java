package com.lonelycat.ot;

import java.util.List;

/**
 * OT 的两个核心算法：compose（合并）和 transform（转换）。
 *
 * <p>两个算法的骨架是一样的：用两个游标同时遍历两个操作的组件列表，
 * 每一步只消耗「两个当前组件中较短的那一段」，把长的那个切掉已经处理的部分继续比较。
 * 这就像两把尺子并排放在文档上对齐，一段一段地往前推进。
 *
 * <p>核心性质（也是测试要验证的）：
 * <pre>
 *   compose:   apply(apply(S, a), b)  == apply(S, compose(a, b))
 *   transform: apply(apply(S, a), b') == apply(S, b) 再 apply a'   其中 (a', b') = transform(a, b)
 * </pre>
 */
public final class OtEngine {

    private OtEngine() {
    }

    /**
     * 把两个连续的操作合并成一个：先做 a 再做 b，等价于做一次 compose(a, b)。
     * 前提：a 的 targetLength 必须等于 b 的 baseLength（b 是作用在 a 之后的文档上的）。
     *
     * <p>用途：客户端在等待服务器确认期间，用户连续输入的多个操作要攒成一个 buffer，
     * 就是靠 compose 把它们合并起来的。
     */
    public static TextOperation compose(TextOperation a, TextOperation b) {
        if (a.getTargetLength() != b.getBaseLength()) {
            throw new IllegalArgumentException(
                    "compose 要求 a.targetLength(" + a.getTargetLength()
                            + ") == b.baseLength(" + b.getBaseLength() + ")");
        }
        TextOperation result = new TextOperation();
        Cursor c1 = new Cursor(a.getOps());
        Cursor c2 = new Cursor(b.getOps());

        while (true) {
            if (c1.done() && c2.done()) {
                break;
            }
            // a 里的 delete：它删的是「原文档」里的字符，b 看不到这些字符，直接照搬
            if (TextOperation.isDelete(c1.current)) {
                result.delete(c1.asInt());
                c1.next();
                continue;
            }
            // b 里的 insert：它插入的是「新内容」，和 a 无关，直接照搬
            if (TextOperation.isInsert(c2.current)) {
                result.insert(c2.asString());
                c2.next();
                continue;
            }
            if (c1.done() || c2.done()) {
                throw new IllegalStateException("compose：两个操作长度不匹配");
            }

            Object op1 = c1.current;
            Object op2 = c2.current;

            if (TextOperation.isRetain(op1) && TextOperation.isRetain(op2)) {
                // 两边都跳过：取较短的一段
                int n1 = c1.asInt();
                int n2 = c2.asInt();
                if (n1 > n2) {
                    result.retain(n2);
                    c1.current = n1 - n2;
                    c2.next();
                } else if (n1 == n2) {
                    result.retain(n1);
                    c1.next();
                    c2.next();
                } else {
                    result.retain(n1);
                    c2.current = n2 - n1;
                    c1.next();
                }
            } else if (TextOperation.isInsert(op1) && TextOperation.isDelete(op2)) {
                // a 插入的内容又被 b 删掉了：这部分互相抵消，什么都不输出
                String s = c1.asString();
                int del = -c2.asInt();
                if (s.length() > del) {
                    c1.current = s.substring(del);
                    c2.next();
                } else if (s.length() == del) {
                    c1.next();
                    c2.next();
                } else {
                    c2.current = c2.asInt() + s.length(); // 还剩一部分要删
                    c1.next();
                }
            } else if (TextOperation.isInsert(op1) && TextOperation.isRetain(op2)) {
                // a 插入的内容被 b 保留：输出这段插入
                String s = c1.asString();
                int n2 = c2.asInt();
                if (s.length() > n2) {
                    result.insert(s.substring(0, n2));
                    c1.current = s.substring(n2);
                    c2.next();
                } else if (s.length() == n2) {
                    result.insert(s);
                    c1.next();
                    c2.next();
                } else {
                    result.insert(s);
                    c2.current = n2 - s.length();
                    c1.next();
                }
            } else if (TextOperation.isRetain(op1) && TextOperation.isDelete(op2)) {
                // a 保留的原文被 b 删掉：输出删除
                int n1 = c1.asInt();
                int del = -c2.asInt();
                if (n1 > del) {
                    result.delete(del);
                    c1.current = n1 - del;
                    c2.next();
                } else if (n1 == del) {
                    result.delete(del);
                    c1.next();
                    c2.next();
                } else {
                    result.delete(n1);
                    c2.current = c2.asInt() + n1;
                    c1.next();
                }
            } else {
                throw new IllegalStateException("compose：遇到不该出现的组件组合 " + op1 + " / " + op2);
            }
        }
        return result;
    }

    /**
     * 转换两个「并发」操作。a 和 b 都是基于同一个文档版本生成的（baseLength 相同），
     * 返回 (a', b')，满足：先做 a 再做 b'，和先做 b 再做 a'，得到同一份文档。
     *
     * <p>约定（前后端必须一致）：两边在同一位置插入时，a 的内容排在 b 的前面。
     * 服务器调用时把「刚收到的客户端操作」当作 a，历史操作当作 b；
     * 客户端调用时把「本地未确认的操作」当作 a，服务器广播来的操作当作 b。
     * 这样在所有节点上，同一对并发操作的先后关系是一致的。
     */
    public static TransformResult transform(TextOperation a, TextOperation b) {
        if (a.getBaseLength() != b.getBaseLength()) {
            throw new IllegalArgumentException(
                    "transform 要求两个操作的 baseLength 相同: "
                            + a.getBaseLength() + " vs " + b.getBaseLength());
        }
        TextOperation aPrime = new TextOperation();
        TextOperation bPrime = new TextOperation();
        Cursor c1 = new Cursor(a.getOps());
        Cursor c2 = new Cursor(b.getOps());

        while (true) {
            if (c1.done() && c2.done()) {
                break;
            }
            // a 插入：a' 照样插入；b' 要跳过这段新内容（因为 b' 作用的文档里已经有它了）
            if (TextOperation.isInsert(c1.current)) {
                String s = c1.asString();
                aPrime.insert(s);
                bPrime.retain(s.length());
                c1.next();
                continue;
            }
            // b 插入：对称处理
            if (TextOperation.isInsert(c2.current)) {
                String s = c2.asString();
                aPrime.retain(s.length());
                bPrime.insert(s);
                c2.next();
                continue;
            }
            if (c1.done() || c2.done()) {
                throw new IllegalStateException("transform：两个操作长度不匹配");
            }

            Object op1 = c1.current;
            Object op2 = c2.current;
            int minLen;

            if (TextOperation.isRetain(op1) && TextOperation.isRetain(op2)) {
                // 两边都跳过同一段原文：a'、b' 也都跳过
                int n1 = c1.asInt();
                int n2 = c2.asInt();
                if (n1 > n2) {
                    minLen = n2;
                    c1.current = n1 - n2;
                    c2.next();
                } else if (n1 == n2) {
                    minLen = n2;
                    c1.next();
                    c2.next();
                } else {
                    minLen = n1;
                    c2.current = n2 - n1;
                    c1.next();
                }
                aPrime.retain(minLen);
                bPrime.retain(minLen);
            } else if (TextOperation.isDelete(op1) && TextOperation.isDelete(op2)) {
                // 两边删的是同一段原文：删一次就够了，a'、b' 都不用再删
                int d1 = -c1.asInt();
                int d2 = -c2.asInt();
                if (d1 > d2) {
                    c1.current = -(d1 - d2);
                    c2.next();
                } else if (d1 == d2) {
                    c1.next();
                    c2.next();
                } else {
                    c2.current = -(d2 - d1);
                    c1.next();
                }
            } else if (TextOperation.isDelete(op1) && TextOperation.isRetain(op2)) {
                // a 删、b 保留：a' 仍然要删这段；b' 里这段已经不存在，所以 b' 什么都不做
                int d1 = -c1.asInt();
                int n2 = c2.asInt();
                if (d1 > n2) {
                    minLen = n2;
                    c1.current = -(d1 - n2);
                    c2.next();
                } else if (d1 == n2) {
                    minLen = n2;
                    c1.next();
                    c2.next();
                } else {
                    minLen = d1;
                    c2.current = n2 - d1;
                    c1.next();
                }
                aPrime.delete(minLen);
            } else if (TextOperation.isRetain(op1) && TextOperation.isDelete(op2)) {
                // 对称：b 删、a 保留
                int n1 = c1.asInt();
                int d2 = -c2.asInt();
                if (n1 > d2) {
                    minLen = d2;
                    c1.current = n1 - d2;
                    c2.next();
                } else if (n1 == d2) {
                    minLen = d2;
                    c1.next();
                    c2.next();
                } else {
                    minLen = n1;
                    c2.current = -(d2 - n1);
                    c1.next();
                }
                bPrime.delete(minLen);
            } else {
                throw new IllegalStateException("transform：遇到不该出现的组件组合 " + op1 + " / " + op2);
            }
        }
        return new TransformResult(aPrime, bPrime);
    }

    /** transform 的返回值：一对转换后的操作 */
    public record TransformResult(TextOperation aPrime, TextOperation bPrime) {
    }

    /**
     * 遍历组件列表的游标。current 可以被算法就地修改（比如 retain(5) 用掉 2 之后变成 retain(3)），
     * 所以不能直接用 Iterator。
     */
    private static final class Cursor {
        private final List<Object> ops;
        private int index = 0;
        Object current;

        Cursor(List<Object> ops) {
            this.ops = ops;
            this.current = ops.isEmpty() ? null : ops.get(0);
        }

        boolean done() {
            return current == null;
        }

        void next() {
            index++;
            current = index < ops.size() ? ops.get(index) : null;
        }

        int asInt() {
            return (Integer) current;
        }

        String asString() {
            return (String) current;
        }
    }
}

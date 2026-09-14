package com.lonelycat.ot;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * 文本操作（OT 的基本单位）。
 *
 * <p>一个操作描述「如何把长度为 {@link #baseLength} 的文档变成长度为 {@link #targetLength} 的文档」。
 * 它由一串「组件」按顺序组成，从文档开头走到结尾：
 * <ul>
 *   <li>retain(n)：光标向后跳过 n 个字符，不做修改</li>
 *   <li>insert(s)：在当前位置插入字符串 s</li>
 *   <li>delete(n)：删除当前位置之后的 n 个字符</li>
 * </ul>
 *
 * <p>例如文档 {@code chat}：
 * <ul>
 *   <li>删除下标 1 的 h：{@code retain(1) delete(1) retain(2)}</li>
 *   <li>在末尾追加 s：{@code retain(4) insert("s")}</li>
 * </ul>
 *
 * <p>内部存储沿用 ot.js 的紧凑表示，便于和前端 JSON 互通：
 * 正整数 = retain，负整数 = delete，字符串 = insert。
 * 所以上面两个操作的 JSON 分别是 {@code [1, -1, 2]} 和 {@code [4, "s"]}。
 *
 * <p>构造时会把相邻的同类组件合并，并且保证「insert 总是排在紧邻的 delete 前面」，
 * 这样同一个语义的操作只有唯一一种表示（规范形式），方便比较和测试。
 */
public final class TextOperation {

    /** 组件列表：Integer(&gt;0)=retain，Integer(&lt;0)=delete，String=insert */
    private final List<Object> ops = new ArrayList<>();

    /** 操作能够作用的文档长度（应用前的长度） */
    private int baseLength = 0;

    /** 操作应用之后文档的长度 */
    private int targetLength = 0;

    public TextOperation() {
    }

    // ------------------------------------------------------------------
    // 组件类型判断
    // ------------------------------------------------------------------

    static boolean isRetain(Object op) {
        return op instanceof Integer i && i > 0;
    }

    static boolean isDelete(Object op) {
        return op instanceof Integer i && i < 0;
    }

    static boolean isInsert(Object op) {
        return op instanceof String;
    }

    // ------------------------------------------------------------------
    // 构建操作（链式调用）
    // ------------------------------------------------------------------

    /** 跳过 n 个字符 */
    public TextOperation retain(int n) {
        if (n < 0) {
            throw new IllegalArgumentException("retain 的长度不能为负数: " + n);
        }
        if (n == 0) {
            return this;
        }
        baseLength += n;
        targetLength += n;
        Object last = lastOp();
        if (isRetain(last)) {
            // 相邻 retain 合并：retain(2) retain(3) => retain(5)
            ops.set(ops.size() - 1, (Integer) last + n);
        } else {
            ops.add(n);
        }
        return this;
    }

    /** 在当前位置插入字符串 */
    public TextOperation insert(String str) {
        Objects.requireNonNull(str, "插入内容不能为 null");
        if (str.isEmpty()) {
            return this;
        }
        targetLength += str.length();
        Object last = lastOp();
        if (isInsert(last)) {
            // 相邻 insert 合并
            ops.set(ops.size() - 1, (String) last + str);
        } else if (isDelete(last)) {
            // 规范形式：insert 放在 delete 前面。
            // "先删 3 个再插 abc" 和 "先插 abc 再删 3 个" 最终文档一样，我们统一为后者。
            Object secondLast = ops.size() >= 2 ? ops.get(ops.size() - 2) : null;
            if (isInsert(secondLast)) {
                ops.set(ops.size() - 2, (String) secondLast + str);
            } else {
                ops.add(ops.size() - 1, str);
            }
        } else {
            ops.add(str);
        }
        return this;
    }

    /** 删除当前位置之后的 n 个字符（传正数或负数都可以） */
    public TextOperation delete(int n) {
        if (n == 0) {
            return this;
        }
        if (n > 0) {
            n = -n;
        }
        baseLength -= n; // n 是负数，所以这里是加上绝对值
        Object last = lastOp();
        if (isDelete(last)) {
            ops.set(ops.size() - 1, (Integer) last + n);
        } else {
            ops.add(n);
        }
        return this;
    }

    private Object lastOp() {
        return ops.isEmpty() ? null : ops.get(ops.size() - 1);
    }

    // ------------------------------------------------------------------
    // 属性
    // ------------------------------------------------------------------

    public int getBaseLength() {
        return baseLength;
    }

    public int getTargetLength() {
        return targetLength;
    }

    /** 只读视图，供算法遍历 */
    public List<Object> getOps() {
        return Collections.unmodifiableList(ops);
    }

    /** 是否是「什么都不改」的空操作（只有 retain 或者根本没有组件） */
    public boolean isNoop() {
        return ops.isEmpty() || (ops.size() == 1 && isRetain(ops.get(0)));
    }

    // ------------------------------------------------------------------
    // 应用到文档
    // ------------------------------------------------------------------

    /**
     * 把操作应用到文档上，得到新文档。
     *
     * @throws IllegalStateException 文档长度和操作的 baseLength 对不上
     */
    public String apply(String doc) {
        if (doc.length() != baseLength) {
            throw new IllegalStateException(
                    "操作的 baseLength(" + baseLength + ") 与文档长度(" + doc.length() + ") 不一致");
        }
        StringBuilder out = new StringBuilder(targetLength);
        int index = 0; // 在原文档中的游标
        for (Object op : ops) {
            if (isRetain(op)) {
                int n = (Integer) op;
                out.append(doc, index, index + n);
                index += n;
            } else if (isInsert(op)) {
                out.append((String) op);
            } else {
                index += -(Integer) op; // 跳过被删除的字符
            }
        }
        if (index != doc.length()) {
            throw new IllegalStateException("操作没有覆盖整个文档");
        }
        return out.toString();
    }

    /**
     * 计算反向操作，用于撤销。需要传入应用前的文档，因为 delete 组件本身不记录被删掉的内容。
     */
    public TextOperation invert(String doc) {
        TextOperation inverse = new TextOperation();
        int index = 0;
        for (Object op : ops) {
            if (isRetain(op)) {
                inverse.retain((Integer) op);
                index += (Integer) op;
            } else if (isInsert(op)) {
                inverse.delete(((String) op).length());
            } else {
                int n = -(Integer) op;
                inverse.insert(doc.substring(index, index + n));
                index += n;
            }
        }
        return inverse;
    }

    // ------------------------------------------------------------------
    // JSON 互转（前后端协议格式）
    // ------------------------------------------------------------------

    /** 导出为紧凑数组，例如 [1, -1, 2] 或 [4, "s"] */
    public List<Object> toJson() {
        return new ArrayList<>(ops);
    }

    /** 从紧凑数组还原。数字类型可能是 Integer / Long（取决于 JSON 库），统一按 int 处理。 */
    public static TextOperation fromJson(List<?> json) {
        TextOperation op = new TextOperation();
        for (Object item : json) {
            if (item instanceof String s) {
                op.insert(s);
            } else if (item instanceof Number num) {
                int n = num.intValue();
                if (n > 0) {
                    op.retain(n);
                } else if (n < 0) {
                    op.delete(n);
                } else {
                    throw new IllegalArgumentException("操作组件不能是 0");
                }
            } else {
                throw new IllegalArgumentException("未知的操作组件: " + item);
            }
        }
        return op;
    }

    // ------------------------------------------------------------------
    // Object 方法
    // ------------------------------------------------------------------

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof TextOperation other)) {
            return false;
        }
        return baseLength == other.baseLength
                && targetLength == other.targetLength
                && ops.equals(other.ops);
    }

    @Override
    public int hashCode() {
        return Objects.hash(ops, baseLength, targetLength);
    }

    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder();
        for (Object op : ops) {
            if (sb.length() > 0) {
                sb.append(", ");
            }
            if (isRetain(op)) {
                sb.append("retain ").append(op);
            } else if (isInsert(op)) {
                sb.append("insert '").append(op).append('\'');
            } else {
                sb.append("delete ").append(-(Integer) op);
            }
        }
        return sb.toString();
    }
}

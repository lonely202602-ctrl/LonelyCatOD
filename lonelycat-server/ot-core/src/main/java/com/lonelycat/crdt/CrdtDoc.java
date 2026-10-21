package com.lonelycat.crdt;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * RGA（Replicated Growable Array）文本 CRDT——教学版。
 *
 * <p>和 OT 的根本区别：OT 同步「操作怎么应用到旧版本」，CRDT 给每个字符发一张
 * 全时空唯一的「身份证」{@link OpId}（站点 id + 站点内逻辑时钟）。插入永远声明
 * 「我插在哪个字符后面」（origin，左邻居），删除只报身份证号（对目标打墓碑）。
 * 这样任何两个副本只要收到过相同的操作集合——不管以什么顺序——都能摆出
 * 完全相同的序列，不需要 transform，也不需要版本号对账。
 *
 * <p>并发插在同一个位置时的定序规则（RGA 的 ID 降序落座）：新条目从 origin
 * 之后开始，跳过所有「身份证比自己大」的条目再落座（纯 ID 降序，不看 origin 是否相同——这样跨源链式插入才收敛）。这条规则只依赖
 * 操作内容本身，所以任何副本独立执行都得到同一结果。
 *
 * <p>为什么本项目不需要因果缓冲：所有操作都经服务器按接收顺序广播（单条
 * TCP 连接），「引用 X 的操作」必然排在 X 的操作之后送达每个副本，origin
 * 永远不会缺席。P2P 场景就没有这个免费午餐了。
 *
 * <p>操作线路格式（与 TypeScript 版逐字段一致）：
 * <pre>
 *   插入 { "t": "i", "id": ["站点", 时钟], "o": [站点, 时钟] | null, "c": "字符" }
 *   删除 { "t": "d", "id": ["站点", 时钟] }
 * </pre>
 */
public class CrdtDoc {

    /** 字符的身份证：站点 id + 站点内递增的逻辑时钟 */
    public record OpId(String site, long clock) implements Comparable<OpId> {

        public static OpId of(List<Object> json) {
            if (json == null || json.size() != 2) {
                throw new IllegalArgumentException("身份证格式应为 [site, clock]: " + json);
            }
            return new OpId(String.valueOf(json.get(0)), ((Number) json.get(1)).longValue());
        }

        public List<Object> toJson() {
            return List.of(site, clock);
        }

        @Override
        public int compareTo(OpId o) {
            int c = Long.compare(clock, o.clock);
            return c != 0 ? c : site.compareTo(o.site);
        }
    }

    /** 序列中的一个条目。删除不物理移除，只打墓碑标记（deleted = true）。 */
    public static final class Entry {
        public final OpId id;
        public final OpId origin;
        public final String ch;
        public boolean deleted;

        Entry(OpId id, OpId origin, String ch, boolean deleted) {
            this.id = id;
            this.origin = origin;
            this.ch = ch;
            this.deleted = deleted;
        }
    }

    private final List<Entry> entries = new ArrayList<>();
    private final String siteId;
    private long clock = 0;

    public CrdtDoc(String siteId) {
        this.siteId = siteId;
    }

    // ------------------------------------------------------------------
    // 本地编辑：产生操作并立即应用到本地
    // ------------------------------------------------------------------

    /**
     * 本地替换：把可见位置 {@code pos} 起的 {@code removeCount} 个字符删掉，
     * 再插入 {@code text}。返回产生的线路格式操作（按产生顺序）。
     * 连续删除时位置不前移（删一个后面的顶上来），连续插入时后一个字符的
     * origin 是前一个字符的身份证。
     */
    public List<Map<String, Object>> localReplace(int pos, int removeCount, String text) {
        List<Map<String, Object>> ops = new ArrayList<>();
        for (int k = 0; k < removeCount; k++) {
            int ei = entryAtVisible(pos);
            if (ei >= entries.size()) {
                break; // 越界就少删几个，别抛——调用方（编辑器桥）保证不了那么严
            }
            Entry victim = entries.get(ei);
            victim.deleted = true;
            ops.add(deleteToJson(victim.id));
        }
        OpId origin = pos == 0 ? null : entries.get(entryAtVisible(pos - 1)).id;
        for (int ci = 0; ci < text.length(); ) {
            int cp = text.codePointAt(ci);
            String ch = new String(Character.toChars(cp));
            clock++;
            OpId id = new OpId(siteId, clock);
            applyInsert(id, origin, ch);
            ops.add(insertToJson(id, origin, ch));
            origin = id;
            ci += Character.charCount(cp);
        }
        return ops;
    }

    // ------------------------------------------------------------------
    // 远程集成：只靠操作内容本身决定位置，与到达顺序无关
    // ------------------------------------------------------------------

    /** 集成远端插入，返回条目下标；重复投递返回 -1 */
    public int applyInsert(OpId id, OpId origin, String ch) {
        if (indexOfId(id) >= 0) {
            return -1; // 重复投递，幂等忽略
        }
        clock = Math.max(clock, id.clock());
        // RGA 定序：从 origin 之后开始，跳过所有「身份证比自己大」的条目再落座。
        // 不看 origin 是否相同——纯 ID 降序才能保证跨源链式插入也收敛（教学版最容易踩的坑）。
        int i = origin == null ? 0 : indexOfId(origin) + 1;
        while (i < entries.size() && entries.get(i).id.compareTo(id) > 0) {
            i++;
        }
        entries.add(i, new Entry(id, origin, ch, false));
        return i;
    }

    /** 集成远端删除（打墓碑），返回条目下标；目标不存在或已是墓碑返回 -1 */
    public int applyDelete(OpId id) {
        int i = indexOfId(id);
        if (i < 0 || entries.get(i).deleted) {
            return -1;
        }
        entries.get(i).deleted = true;
        return i;
    }

    // ------------------------------------------------------------------
    // 可见位置 <-> 条目下标
    // ------------------------------------------------------------------

    public int visibleLength() {
        int n = 0;
        for (Entry e : entries) {
            if (!e.deleted) {
                n++;
            }
        }
        return n;
    }

    /** 可见位置 -> 条目下标；pos == visibleLength() 时返回 entries.size() */
    public int entryAtVisible(int pos) {
        if (pos < 0 || pos > visibleLength()) {
            throw new IllegalArgumentException("可见位置越界: " + pos);
        }
        int visible = 0;
        for (int i = 0; i < entries.size(); i++) {
            if (visible == pos && !entries.get(i).deleted) {
                return i;
            }
            if (!entries.get(i).deleted) {
                visible++;
            }
        }
        return entries.size(); // 末尾
    }

    /** 条目下标 -> 可见位置（不含自己） */
    public int visibleIndexOf(int entryIdx) {
        int visible = 0;
        for (int i = 0; i < entryIdx; i++) {
            if (!entries.get(i).deleted) {
                visible++;
            }
        }
        return visible;
    }

    public String getText() {
        StringBuilder sb = new StringBuilder();
        for (Entry e : entries) {
            if (!e.deleted) {
                sb.append(e.ch);
            }
        }
        return sb.toString();
    }

    public List<Entry> getEntries() {
        return entries;
    }

    // ------------------------------------------------------------------
    // 副本状态导出/导入（新成员加入时随 snapshot 全量同步——光有文本不行，
    // 别人后续要引用这些字符的身份证）
    // ------------------------------------------------------------------

    /** 每个条目压成 [id, origin|null, ch, deleted] 四元组。用 Arrays.asList：List.of 不收 null，而 origin 可为 null */
    public List<List<Object>> stateToJson() {
        List<List<Object>> state = new ArrayList<>();
        for (Entry e : entries) {
            state.add(java.util.Arrays.asList(e.id.toJson(), e.origin == null ? null : e.origin.toJson(), e.ch, e.deleted));
        }
        return state;
    }

    public void loadState(List<List<Object>> state) {
        entries.clear();
        for (List<Object> row : state) {
            @SuppressWarnings("unchecked")
            List<Object> id = (List<Object>) row.get(0);
            @SuppressWarnings("unchecked")
            List<Object> origin = row.get(1) == null ? null : (List<Object>) row.get(1);
            entries.add(new Entry(OpId.of(id), origin == null ? null : OpId.of(origin),
                    String.valueOf(row.get(2)), Boolean.TRUE.equals(row.get(3))));
            clock = Math.max(clock, OpId.of(id).clock());
        }
    }

    // ------------------------------------------------------------------
    // 操作的线路格式
    // ------------------------------------------------------------------

    public static Map<String, Object> insertToJson(OpId id, OpId origin, String ch) {
        return Map.of("t", "i", "id", id.toJson(), "o", origin == null ? List.of() : origin.toJson(), "c", ch);
    }

    public static Map<String, Object> deleteToJson(OpId id) {
        return Map.of("t", "d", "id", id.toJson());
    }

    /** 从线路格式解析并应用插入（o 为空数组表示 origin = null） */
    public int applyInsertJson(Map<String, Object> json) {
        requireType(json, "i");
        @SuppressWarnings("unchecked")
        List<Object> id = (List<Object>) json.get("id");
        @SuppressWarnings("unchecked")
        List<Object> o = (List<Object>) json.get("o");
        return applyInsert(OpId.of(id), o == null || o.isEmpty() ? null : OpId.of(o), String.valueOf(json.get("c")));
    }

    /** 从线路格式解析并应用删除 */
    public int applyDeleteJson(Map<String, Object> json) {
        requireType(json, "d");
        @SuppressWarnings("unchecked")
        List<Object> id = (List<Object>) json.get("id");
        return applyDelete(OpId.of(id));
    }

    private static void requireType(Map<String, Object> json, String expected) {
        if (!expected.equals(json.get("t"))) {
            throw new IllegalArgumentException("操作类型不符，期望 " + expected + ": " + json);
        }
    }

    private int indexOfId(OpId id) {
        for (int i = 0; i < entries.size(); i++) {
            if (entries.get(i).id.equals(id)) {
                return i;
            }
        }
        return -1;
    }
}

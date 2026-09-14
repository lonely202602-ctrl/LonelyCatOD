package com.lonelycat.server.protocol;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;

/**
 * WebSocket 消息。前后端共用同一个结构，靠 {@link #type} 区分含义，用不到的字段为 null 时不序列化。
 *
 * <p>客户端 → 服务器：
 * <pre>
 *   join    { docId, name }                    加入文档，服务器回 snapshot
 *   op      { docId, revision, op }            提交操作，revision 是客户端所基于的版本号
 *   cursor  { docId, cursor:{anchor, head} }   广播光标位置
 *   leave   { docId }                          离开文档
 * </pre>
 *
 * <p>服务器 → 客户端：
 * <pre>
 *   snapshot { docId, revision, content, clientId, clients }   加入成功，给全量内容和当前在线用户
 *   ack      { docId, revision }                                你提交的操作已被接受，revision 是它成为的版本号
 *   op       { docId, revision, op, author }                    别人的操作（已经转换到最新版本）
 *   cursor   { docId, author, cursor }                          别人的光标
 *   joined   { docId, client:{clientId, name} }                 有人加入
 *   left     { docId, clientId }                                有人离开
 *   error    { message }                                        出错
 * </pre>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class Message {

    public String type;
    public String docId;

    /** op 消息：客户端发送时表示所基于的版本，服务器广播时表示该操作成为的新版本 */
    public Integer revision;

    /** 操作的紧凑 JSON 表示，例如 [1, -1, 2] */
    public List<Object> op;

    /** 操作或光标的来源客户端 id */
    public String author;

    /** snapshot 消息：文档全文 */
    public String content;

    /** snapshot 消息：分配给当前连接的客户端 id */
    public String clientId;

    /** join 消息：用户显示名 */
    public String name;

    /** 光标：{ anchor: int, head: int }，anchor 是选区起点，head 是光标位置 */
    public Map<String, Integer> cursor;

    /** snapshot 消息：当前在线的其他用户 */
    public List<ClientInfo> clients;

    /** joined 消息：新加入的用户 */
    public ClientInfo client;

    /** error 消息 */
    public String message;

    public Message() {
    }

    public static Message of(String type) {
        Message m = new Message();
        m.type = type;
        return m;
    }

    public static Message error(String message) {
        Message m = of("error");
        m.message = message;
        return m;
    }

    /** 在线用户的公开信息 */
    public record ClientInfo(String clientId, String name) {
    }
}

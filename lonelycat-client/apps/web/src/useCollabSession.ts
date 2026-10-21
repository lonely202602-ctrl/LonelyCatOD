import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { CrdtSyncAdapter, OtSyncAdapter, type RemoteClient } from '@lonelycat/sync';
import { collab, crdtCollab, remoteAnnotation } from '@lonelycat/editor';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { wsUrl } from './config';
import type { ConnStatus } from './components/ui';

/** 编辑器实时统计，页脚状态栏展示 */
export interface EditorStats {
  chars: number;
  lines: number;
  cursorLine: number;
  cursorCol: number;
}

export interface CollabHandlers {
  onError: (msg: string) => void;
  /** 有人正在输入（心跳，clientId）。调用方自己做超时隐藏 */
  onTyping?: (clientId: string) => void;
  /** 有人加入（除自己） */
  onJoined?: (client: RemoteClient) => void;
  /** 有人离开，带上离开前的资料（列表里已经查不到时也能显示名字） */
  onLeft?: (client: RemoteClient) => void;
  /** 当前文档被删除，收到后应离开编辑页 */
  onDeleted?: () => void;
}

/**
 * React 与协同层的唯一接缝：
 *   - 挂载时创建 OtSyncAdapter + CodeMirror EditorView（各一份，随组件销毁）
 *   - adapter 的事件翻译成 React state（连接状态、在线成员、版本号、统计、错误）
 *   - 编辑器内部的数据流仍然走 packages/editor 的 collab() 扩展，不经过 React
 */
export function useCollabSession(
  docId: string,
  name: string,
  containerRef: RefObject<HTMLDivElement | null>,
  handlers: CollabHandlers,
  engine: 'ot' | 'crdt' = 'ot',
) {
  const { onError, onTyping, onJoined, onLeft, onDeleted } = handlers;
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [revision, setRevision] = useState(0);
  const [stateName, setStateName] = useState(engine === 'crdt' ? 'Replicated' : 'Synchronized');
  const [online, setOnline] = useState<RemoteClient[]>([]);
  const [stats, setStats] = useState<EditorStats>({ chars: 0, lines: 1, cursorLine: 1, cursorCol: 1 });
  const viewRef = useRef<EditorView | null>(null);
  // 给 onLeft 回调查「离开者是谁」用的镜像（state 更新是异步的，直接查会拿不到）
  const onlineRef = useRef<RemoteClient[]>([]);
  onlineRef.current = online;
  // 回调经 ref 转发，保证 effect 内拿到的永远是最新版本且不重挂会话
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    // 两种引擎共用同一组生命周期事件；差别只在数据形状（remoteOp vs remoteChange）与扩展
    const adapter =
      engine === 'crdt'
        ? new CrdtSyncAdapter({ url: wsUrl, docId, name })
        : new OtSyncAdapter({ url: wsUrl, docId, name });
    const unsubs: (() => void)[] = [];
    let selfId = '';
    // 两种适配器对「与引擎无关」的事件用同一套名字；TS 的联合类型调用挑剔，这里统一按 OT 形状订阅
    const bus = adapter as OtSyncAdapter;

    unsubs.push(bus.on('status', setStatus));
    unsubs.push(
      bus.on('snapshot', (_content, revision, self, others) => {
        selfId = self.clientId;
        setRevision(revision);
        // 「我」排最前，其余按加入顺序
        setOnline([{ ...self, name: `${self.name}（我）` }, ...others.filter((o) => o.clientId !== self.clientId)]);
      }),
    );
    unsubs.push(
      bus.on('joined', (c) => {
        setOnline((list) => {
          if (list.some((u) => u.clientId === c.clientId)) return list;
          const me = list.filter((u) => u.clientId === selfId);
          return [...me, ...list.filter((u) => u.clientId !== selfId), c];
        });
        handlersRef.current.onJoined?.(c);
      }),
    );
    unsubs.push(
      bus.on('left', (id) => {
        const gone = onlineRef.current.find((u) => u.clientId === id);
        setOnline((list) => list.filter((u) => u.clientId !== id));
        handlersRef.current.onLeft?.(gone ?? { clientId: id, name: id });
      }),
    );
    if (onTyping) unsubs.push(bus.on('typing', (id) => handlersRef.current.onTyping?.(id)));
    if (onDeleted) unsubs.push(bus.on('deleted', () => handlersRef.current.onDeleted?.()));
    unsubs.push(bus.on('error', (m) => handlersRef.current.onError(m)));

    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          drawSelection(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          highlightActiveLine(),
          engine === 'crdt'
            ? crdtCollab({ adapter: adapter as CrdtSyncAdapter })
            : collab({ adapter: adapter as OtSyncAdapter }),
          // 版本号/统计/typing 的变化顺手同步给 React；值不变时 setState 自动跳过重渲染
          EditorView.updateListener.of((update) => {
            setRevision(adapter.revision);
            setStateName(adapter.stateName);
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            setStats({
              chars: update.state.doc.length,
              lines: update.state.doc.lines,
              cursorLine: line.number,
              cursorCol: head - line.from + 1,
            });
            // 本地有编辑 → 通知别人「我正在输入」（适配器内部节流）
            if (
              update.docChanged &&
              update.transactions.some((tr) => !tr.annotation(remoteAnnotation))
            ) {
              adapter.sendTyping();
            }
          }),
        ],
      }),
      parent: containerRef.current!,
    });
    viewRef.current = view;

    adapter.connect();

    return () => {
      unsubs.forEach((u) => u());
      adapter.disconnect();
      view.destroy();
      viewRef.current = null;
    };
    // docId 变化 = 换文档，整个重建；engine 变化（REST 异步取到）= 换适配器，也要整个重建
    // handlers 由调用方保证稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, engine]);

  return { status, revision, stateName, online, stats, viewRef };
}

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { OtSyncAdapter, type RemoteClient } from '@lonelycat/sync';
import { collab } from '@lonelycat/editor';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { wsUrl } from './config';
import type { ConnStatus } from './components/ui';

/**
 * React 与协同层的唯一接缝：
 *   - 挂载时创建 OtSyncAdapter + CodeMirror EditorView（各一份，随组件销毁）
 *   - adapter 的事件翻译成 React state（连接状态、在线成员、版本号、错误）
 *   - 编辑器内部的数据流仍然走 packages/editor 的 collab() 扩展，不经过 React
 */
export function useCollabSession(
  docId: string,
  name: string,
  containerRef: RefObject<HTMLDivElement | null>,
  onError: (msg: string) => void,
) {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [revision, setRevision] = useState(0);
  const [stateName, setStateName] = useState('Synchronized');
  const [online, setOnline] = useState<RemoteClient[]>([]);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const adapter = new OtSyncAdapter({ url: wsUrl, docId, name });
    const unsubs: (() => void)[] = [];
    let selfId = '';

    unsubs.push(adapter.on('status', setStatus));
    unsubs.push(
      adapter.on('snapshot', (_content, revision, self, others) => {
        selfId = self.clientId;
        setRevision(revision);
        // 「我」排最前，其余按加入顺序
        setOnline([{ ...self, name: `${self.name}（我）` }, ...others.filter((o) => o.clientId !== self.clientId)]);
      }),
    );
    unsubs.push(
      adapter.on('joined', (c) => {
        setOnline((list) => {
          if (list.some((u) => u.clientId === c.clientId)) return list;
          const me = list.filter((u) => u.clientId === selfId);
          return [...me, ...list.filter((u) => u.clientId !== selfId), c];
        });
      }),
    );
    unsubs.push(adapter.on('left', (id) => setOnline((list) => list.filter((u) => u.clientId !== id))));
    unsubs.push(adapter.on('error', onError));

    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          drawSelection(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          highlightActiveLine(),
          collab({ adapter }),
          // 版本号/状态机名的变化顺手同步给 React；值不变时 setState 自动跳过重渲染
          EditorView.updateListener.of(() => {
            setRevision(adapter.revision);
            setStateName(adapter.stateName);
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
    // docId 变化 = 换文档，整个重建；name/onError 由调用方保证稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  return { status, revision, stateName, online, viewRef };
}

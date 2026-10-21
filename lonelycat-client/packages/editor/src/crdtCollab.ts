import { Annotation, type ChangeSpec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { CrdtSyncAdapter } from '@lonelycat/sync';
import { remoteCursorsExtension, setRemoteCursor, removeRemoteCursor, clearRemoteCursors } from './remoteCursors';

/**
 * CodeMirror 6 与 CRDT 同步层的桥接（与 collab.ts 的 OT 桥对照着看）。
 *
 * 数据流：
 *   用户打字 → CodeMirror 事务 → 逐段换算成 CRDT 替换 → adapter.applyLocalReplace
 *   adapter 'remoteChange' 事件 → view.dispatch（带 remoteAnnotation 标记，不再回传）
 *
 * 关键差别：iterChanges 给出的 fromA/toA 是相对「事务前旧文档」的位置，
 * 而本地 CRDT 副本每应用一段就会变化，所以第二段起要加上前面段落造成的长度偏移 delta。
 */

/** 标记「这个事务来自远端，不要再发回服务器」（与 OT 桥共用同一个标记语义） */
export const crdtRemoteAnnotation = Annotation.define<boolean>();

export interface CrdtCollabOptions {
  adapter: CrdtSyncAdapter;
  colorFor?: (clientId: string) => string;
}

export function crdtCollab(options: CrdtCollabOptions): Extension {
  const { adapter } = options;
  const names = new Map<string, string>();

  const plugin = ViewPlugin.define((view) => {
    const unsubscribers: (() => void)[] = [];

    unsubscribers.push(
      adapter.on('snapshot', (content, _revision, _self, others) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
          annotations: crdtRemoteAnnotation.of(true),
          effects: clearRemoteCursors.of(null),
        });
        names.clear();
        for (const o of others) names.set(o.clientId, o.name);
      }),
    );

    unsubscribers.push(
      adapter.on('remoteChange', (changes) => {
        view.dispatch({ changes, annotations: crdtRemoteAnnotation.of(true) });
      }),
    );

    unsubscribers.push(
      adapter.on('cursor', (cursor) => {
        view.dispatch({
          effects: setRemoteCursor.of({
            clientId: cursor.clientId,
            name: names.get(cursor.clientId) ?? cursor.clientId,
            anchor: Math.min(cursor.anchor, view.state.doc.length),
            head: Math.min(cursor.head, view.state.doc.length),
            color: options.colorFor?.(cursor.clientId) ?? defaultColor(cursor.clientId),
          }),
        });
      }),
    );

    unsubscribers.push(adapter.on('joined', (c) => names.set(c.clientId, c.name)));
    unsubscribers.push(
      adapter.on('left', (clientId) => {
        names.delete(clientId);
        view.dispatch({ effects: removeRemoteCursor.of(clientId) });
      }),
    );

    return {
      update(update: ViewUpdate) {
        const isRemote = update.transactions.some((tr) => tr.annotation(crdtRemoteAnnotation));
        if (update.docChanged && !isRemote) {
          let delta = 0; // 前面各段 (插入长度 - 删除长度) 的累计偏移
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            adapter.applyLocalReplace(fromA + delta, toA - fromA, inserted.toString());
            delta += inserted.length - (toA - fromA);
          });
        }
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          adapter.sendCursor(sel.anchor, sel.head);
        }
      },
      destroy() {
        unsubscribers.forEach((u) => u());
      },
    };
  });

  return [plugin, remoteCursorsExtension()];
}

function defaultColor(clientId: string): string {
  const palette = ['#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#0091b2', '#e93d82', '#b0891c'];
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) hash = (hash * 31 + clientId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

export type { ChangeSpec };

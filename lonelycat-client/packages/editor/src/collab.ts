import { Annotation, type ChangeSet, type ChangeSpec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { TextOperation } from '@lonelycat/ot-core';
import type { SyncAdapter } from '@lonelycat/sync';
import { remoteCursorsExtension, setRemoteCursor, removeRemoteCursor, clearRemoteCursors } from './remoteCursors';

/**
 * CodeMirror 6 与同步层的桥接。
 *
 * 数据流：
 *   用户打字 → CodeMirror 事务(changes) → changesToOperation → adapter.applyLocal(op)
 *   adapter 'remoteOp' 事件 → operationToChanges → view.dispatch（带 remoteAnnotation 标记）
 *
 * 用 remoteAnnotation 标记远端事务，updateListener 看到这个标记就不再回传给同步层，避免回环。
 */

/** 标记「这个事务来自远端，不要再发回服务器」 */
export const remoteAnnotation = Annotation.define<boolean>();

/**
 * 把 CodeMirror 的 ChangeSet 转成 TextOperation。
 * iterChanges 按文档顺序给出每一段 (fromA, toA) 被替换成 inserted，位置都是相对旧文档的，
 * 所以可以从左到右依次 retain / delete / insert。
 *
 * 参数只要求有 changes 和 startState 两个字段，ViewUpdate 和 Transaction 都满足，方便测试。
 */
export function changesToOperation(update: { changes: ChangeSet; startState: EditorState }): TextOperation {
  const op = new TextOperation();
  let pos = 0;
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    op.retain(fromA - pos);
    op.delete(toA - fromA);
    op.insert(inserted.toString());
    pos = toA;
  });
  op.retain(update.startState.doc.length - pos);
  return op;
}

/**
 * 把 TextOperation 转成 CodeMirror 的 ChangeSpec 列表。
 * 所有 from/to 都是相对「应用前」文档的位置，CodeMirror 会自己处理多段变更之间的偏移。
 */
export function operationToChanges(op: TextOperation): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let pos = 0;
  for (const c of op.ops) {
    if (typeof c === 'string') {
      changes.push({ from: pos, insert: c });
    } else if (c > 0) {
      pos += c;
    } else {
      changes.push({ from: pos, to: pos - c });
      pos -= c;
    }
  }
  return changes;
}

export interface CollabOptions {
  adapter: SyncAdapter;
  /** 给远端用户分配颜色（可选） */
  colorFor?: (clientId: string) => string;
}

/**
 * 创建协同编辑扩展。用法：
 *   new EditorView({ extensions: [collab({ adapter }), ...] })
 */
export function collab(options: CollabOptions): Extension {
  const { adapter } = options;
  const names = new Map<string, string>();

  const plugin = ViewPlugin.define((view) => {
    const unsubscribers: (() => void)[] = [];

    // 远端全文快照：整体替换
    unsubscribers.push(
      adapter.on('snapshot', (content, _revision, _self, others) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
          annotations: remoteAnnotation.of(true),
          effects: clearRemoteCursors.of(null),
        });
        names.clear();
        for (const o of others) names.set(o.clientId, o.name);
      }),
    );

    // 远端操作：转成 changes 应用
    unsubscribers.push(
      adapter.on('remoteOp', (op) => {
        if (op.baseLength !== view.state.doc.length) {
          // 理论上不会发生；发生了说明本地和服务器已经失步
          console.error('远端操作长度与编辑器内容不匹配', op.baseLength, view.state.doc.length);
          return;
        }
        view.dispatch({
          changes: operationToChanges(op),
          annotations: remoteAnnotation.of(true),
        });
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
        const isRemote = update.transactions.some((tr) => tr.annotation(remoteAnnotation));
        if (update.docChanged && !isRemote) {
          adapter.applyLocal(changesToOperation(update));
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

/** 根据 clientId 稳定地挑一个颜色 */
function defaultColor(clientId: string): string {
  const palette = ['#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#0091b2', '#e93d82', '#b0891c'];
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) hash = (hash * 31 + clientId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

export type { EditorState };

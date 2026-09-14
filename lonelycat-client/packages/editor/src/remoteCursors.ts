import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

/**
 * 远端光标显示。
 *
 * 光标位置存在 StateField 里；每来一个事务，就用 tr.changes.mapPos 把所有远端光标位置
 * 映射到新文档上。这等价于 OT 里的「光标随操作转换」，只不过交给 CodeMirror 内置的位置映射来做。
 */

export interface RemoteCursorState {
  clientId: string;
  name: string;
  anchor: number;
  head: number;
  color: string;
}

export const setRemoteCursor = StateEffect.define<RemoteCursorState>();
export const removeRemoteCursor = StateEffect.define<string>();
export const clearRemoteCursors = StateEffect.define<null>();

const cursorsField = StateField.define<Map<string, RemoteCursorState>>({
  create: () => new Map(),
  update(cursors, tr) {
    let next = cursors;
    // 位置映射：文档变了，光标要跟着挪
    if (tr.docChanged) {
      next = new Map();
      for (const [id, c] of cursors) {
        next.set(id, { ...c, anchor: tr.changes.mapPos(c.anchor), head: tr.changes.mapPos(c.head) });
      }
    }
    for (const e of tr.effects) {
      if (e.is(setRemoteCursor)) {
        if (next === cursors) next = new Map(cursors);
        next.set(e.value.clientId, e.value);
      } else if (e.is(removeRemoteCursor)) {
        if (next === cursors) next = new Map(cursors);
        next.delete(e.value);
      } else if (e.is(clearRemoteCursors)) {
        next = new Map();
      }
    }
    return next;
  },
});

/** 画一个竖线光标，鼠标悬停显示名字 */
class CaretWidget extends WidgetType {
  constructor(
    private readonly name: string,
    private readonly color: string,
  ) {
    super();
  }

  eq(other: CaretWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'lc-remote-caret';
    el.style.borderLeftColor = this.color;
    const label = document.createElement('span');
    label.className = 'lc-remote-caret-label';
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    el.appendChild(label);
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const decorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_deco, tr) {
    const cursors = tr.state.field(cursorsField);
    const ranges = [];
    for (const c of cursors.values()) {
      const from = Math.min(c.anchor, c.head);
      const to = Math.max(c.anchor, c.head);
      if (from !== to) {
        // 选区高亮
        ranges.push(
          Decoration.mark({
            class: 'lc-remote-selection',
            attributes: { style: `background-color: ${c.color}33` },
          }).range(from, to),
        );
      }
      ranges.push(Decoration.widget({ widget: new CaretWidget(c.name, c.color), side: 1 }).range(c.head));
    }
    // Decoration.set 要求按位置排序
    ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    return Decoration.set(ranges, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.baseTheme({
  '.lc-remote-caret': {
    position: 'relative',
    borderLeft: '2px solid',
    marginLeft: '-1px',
  },
  '.lc-remote-caret-label': {
    position: 'absolute',
    top: '-1.3em',
    left: '-2px',
    fontSize: '0.7em',
    lineHeight: '1.2',
    padding: '1px 4px',
    borderRadius: '3px',
    color: 'white',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    userSelect: 'none',
  },
});

export function remoteCursorsExtension(): Extension {
  return [cursorsField, decorationsField, theme];
}

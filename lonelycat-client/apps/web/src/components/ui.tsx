import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * 手写 UI 基础组件。刻意不引组件库：
 * 这个应用的交互面很小（按钮/输入框/弹窗/提示），自己写能完全贴合设计系统，
 * 也符合「组件库除非交互和 UI 都极好否则不用」的原则。
 */

// ----------------------------------------------------------------------
// Button
// ----------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent hover:bg-accent-hover shadow-sm font-medium',
  secondary:
    'bg-surface text-text border border-line hover:border-line-strong hover:bg-surface-2',
  ghost: 'text-muted hover:text-text hover:bg-surface-2',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${buttonStyles[variant]} ${className}`}
    />
  );
}

// ----------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-text placeholder:text-muted outline-none transition-colors focus:border-accent focus:ring-2 focus-visible:ring-ring ${className}`}
    />
  );
}

// ----------------------------------------------------------------------
// 状态徽章：呼吸圆点 + 文字，对应 WebSocket 连接状态
// ----------------------------------------------------------------------

export type ConnStatus = 'connecting' | 'connected' | 'disconnected';

const statusMeta: Record<ConnStatus, { label: string; dot: string; text: string; bg: string; pulse?: boolean }> = {
  connected: { label: '已连接', dot: 'bg-ok', text: 'text-ok', bg: 'bg-ok-soft' },
  connecting: { label: '连接中', dot: 'bg-warn', text: 'text-warn', bg: 'bg-warn-soft', pulse: true },
  disconnected: { label: '已断开', dot: 'bg-err', text: 'text-err', bg: 'bg-err-soft' },
};

export function StatusPill({ status }: { status: ConnStatus }) {
  const m = statusMeta[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${m.bg} ${m.text}`}>
      <span className={`size-1.5 rounded-full ${m.dot} ${m.pulse ? 'lc-pulse' : ''}`} />
      {m.label}
    </span>
  );
}

// ----------------------------------------------------------------------
// 头像：clientId 哈希取色，颜色系统与远端光标一致的感觉
// ----------------------------------------------------------------------

const AVATAR_COLORS = ['#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#0091b2', '#e93d82', '#b0891c'];

export function colorFor(clientId: string): string {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) hash = (hash * 31 + clientId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function Avatar({ name, clientId, size = 26, title }: { name: string; clientId: string; size?: number; title?: string }) {
  return (
    <span
      title={title ?? name}
      style={{
        width: size,
        height: size,
        backgroundColor: colorFor(clientId),
        fontSize: size * 0.42,
      }}
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white ring-2 ring-bg select-none"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** 叠放的在线成员头像，最多显示 4 个，其余折叠成 +N */
export function AvatarStack({ users, max = 4 }: { users: { clientId: string; name: string }[]; max?: number }) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <div className="flex -space-x-1.5">
      {shown.map((u) => (
        <Avatar key={u.clientId} name={u.name} clientId={u.clientId} />
      ))}
      {rest > 0 && (
        <span
          className="grid size-[26px] place-items-center rounded-full bg-surface-3 text-[11px] font-medium text-text-secondary ring-2 ring-bg"
          title={users.slice(max).map((u) => u.name).join('、')}
        >
          +{rest}
        </span>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Modal：极简对话框（背板 + 居中卡片），Esc 关闭，自动聚焦
// ----------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 380,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: number;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // 打开后把第一个输入框聚焦
    requestAnimationFrame(() => {
      cardRef.current?.querySelector<HTMLInputElement>('input, textarea')?.focus();
    });
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        style={{ width }}
        className="lc-fade-up rounded-2xl border border-line bg-surface p-5 shadow-pop"
      >
        <h2 className="mb-4 text-[15px] font-semibold text-text">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ----------------------------------------------------------------------
// Toast：右下角错误/提示条
// ----------------------------------------------------------------------

interface ToastItem {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

const ToastContext = createContext<(text: string, kind?: ToastItem['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((text: string, kind: ToastItem['kind'] = 'error') => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, text, kind }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 5000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={`lc-fade-up flex max-w-sm items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm shadow-pop ${
              t.kind === 'error' ? 'border-line bg-surface text-err' : 'border-line bg-surface text-text'
            }`}
          >
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-current" />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ----------------------------------------------------------------------
// Spinner
// ----------------------------------------------------------------------

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

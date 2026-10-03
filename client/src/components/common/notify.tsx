import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

/**
 * 自实现的轻量通知系统。
 *
 * 为什么不用 animal-island-ui 的 Notification：它的 NotificationPortal 用自己 vendored 的
 * react-dom 的 createRoot 挂载，与本项目 React 19 不兼容 → 每次调用都抛
 * "createRoot is not a function"（未捕获 rejection，且用户根本看不到任何提示）。
 * 本实现渲染在本应用的 React 树内（ToastHost 挂在 App 顶层），无 createRoot 问题。
 */

type ToastType = 'success' | 'error' | 'warning' | 'info';
interface Toast { id: number; type: ToastType; message: string; description?: string; }
interface ToastInput { message: string; description?: string; }

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit() { for (const l of listeners) l(); }
function dismiss(id: number) { toasts = toasts.filter(t => t.id !== id); emit(); }
function push(type: ToastType, input: ToastInput) {
  const id = ++seq;
  toasts = [...toasts, { id, type, message: input.message, description: input.description }];
  emit();
  setTimeout(() => dismiss(id), type === 'error' ? 7000 : 4500);
}

export const Notification = {
  success: (o: ToastInput) => push('success', o),
  error: (o: ToastInput) => push('error', o),
  warning: (o: ToastInput) => push('warning', o),
  info: (o: ToastInput) => push('info', o),
};

const THEME: Record<ToastType, { color: string; Icon: typeof Info }> = {
  success: { color: 'var(--sm-success)', Icon: CheckCircle },
  error: { color: 'var(--sm-error)', Icon: XCircle },
  warning: { color: 'var(--sm-warning)', Icon: AlertTriangle },
  info: { color: 'var(--sm-primary)', Icon: Info },
};

/** 通知宿主：挂在 App 顶层，订阅通知队列并渲染（走本应用 React 树） */
export function ToastHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(n => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  return (
    <div
      style={{
        position: 'fixed', top: 14, left: '50%', transform: 'translateX(-50%)',
        zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 10,
        width: 'min(92vw, 380px)', pointerEvents: 'none',
      }}
    >
      {toasts.map(t => {
        const { color, Icon } = THEME[t.type];
        return (
          <div
            key={t.id}
            className="sm-fade-up"
            onClick={() => dismiss(t.id)}
            role="alert"
            style={{
              pointerEvents: 'auto', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start',
              padding: '12px 14px', borderRadius: 16, background: 'var(--sm-bg-content)',
              border: '2px solid var(--sm-border)', borderLeft: `6px solid ${color}`,
              boxShadow: '0 6px 0 0 var(--sm-shadow-input)',
            }}
          >
            <span style={{ color, flex: 'none', marginTop: 1 }}><Icon size={18} strokeWidth={2.6} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--sm-text)' }}>{t.message}</span>
              {t.description && (
                <span style={{ display: 'block', fontSize: 12, marginTop: 2, color: 'var(--sm-text-secondary)', lineHeight: 1.55 }}>
                  {t.description}
                </span>
              )}
            </span>
            <span style={{ color: 'var(--sm-text-muted)', flex: 'none', marginTop: 1 }}><X size={14} /></span>
          </div>
        );
      })}
    </div>
  );
}

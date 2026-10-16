import clsx from 'clsx'
import { X } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { initials } from '@/lib/format'

export const cx = clsx

// ---------------------------------------------------------------- botões
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai'
const variants: Record<Variant, string> = {
  primary: 'bg-coral text-white hover:brightness-[1.06] active:brightness-95 shadow-[0_1px_0_rgb(0_0_0/0.08)]',
  secondary: 'bg-panel text-ink border border-line-strong hover:bg-panel-2',
  ghost: 'text-ink-2 hover:bg-panel-2 hover:text-ink',
  danger: 'bg-transparent text-coral-ink border border-coral/40 hover:bg-coral-soft',
  ai: 'bg-nimbus-soft text-nimbus-ink border border-nimbus/50 hover:bg-nimbus/30',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }
>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[8px] font-medium transition-[background,filter,color] duration-150 disabled:opacity-50 disabled:pointer-events-none select-none whitespace-nowrap',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-sm',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  )
})

export function IconButton({
  label,
  className,
  children,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-9 items-center justify-center rounded-[8px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-40',
        active && 'bg-panel-2 text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- formulários
/** Largura padrão 100%, a não ser que o className já defina uma largura (w-…). */
const widthOf = (className?: string) => (className && /(^|\s)w-/.test(className) ? '' : 'w-full')
const fieldBase =
  'rounded-[8px] border border-line-strong bg-panel px-3 text-sm text-ink placeholder:text-muted outline-none transition-colors focus:border-ink/40 focus:ring-2 focus:ring-coral/20 disabled:opacity-60'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(fieldBase, widthOf(className), 'h-10', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, widthOf(className), 'py-2.5 leading-relaxed resize-y min-h-[84px]', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(fieldBase, widthOf(className), 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  )
})

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block space-y-1.5', className)}>
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="block text-[12px] text-coral-ink">{error}</span> : hint ? <span className="block text-[12px] text-muted">{hint}</span> : null}
    </label>
  )
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; description?: string; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-3', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-coral' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
      {(label || description) && (
        <span>
          {label && <span className="block text-sm text-ink">{label}</span>}
          {description && <span className="block text-[12px] text-muted">{description}</span>}
        </span>
      )}
    </label>
  )
}

// ---------------------------------------------------------------- exibição
export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'coral' | 'ai' | 'ok' | 'warn'; className?: string }) {
  const tones = {
    neutral: 'bg-panel-2 text-ink-2',
    coral: 'bg-coral-soft text-coral-ink',
    ai: 'bg-nimbus-soft text-nimbus-ink',
    ok: 'bg-ok/12 text-ok',
    warn: 'bg-warn/15 text-warn',
  }
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 py-0.5 text-[11.5px] font-medium leading-none', tones[tone], className)}>{children}</span>
}

export function TagChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-line px-1.5 py-0.5 text-[11.5px] text-ink-2">
      <span className="size-1.5 rounded-[1px]" style={{ background: color }} />
      {name}
    </span>
  )
}

/** Avatar quadrado com cantos levemente arredondados — eco dos "pixels" da marca. */
export function Avatar({ name, color, size = 36, className }: { name: string; color?: string; size?: number; className?: string }) {
  return (
    <span
      className={cx('inline-flex shrink-0 items-center justify-center rounded-[9px] font-semibold text-navy', className)}
      style={{ width: size, height: size, fontSize: size * 0.36, background: color ?? 'var(--nimbus)' }}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className ?? 'size-5')} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Empty({ title, children, action, glyph }: { title: string; children?: ReactNode; action?: ReactNode; glyph?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-12 text-center">
      {glyph ?? <PixelGlyph pattern="empty" className="text-line-strong" size={44} />}
      <div className="font-display text-xl text-ink">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
      {action}
    </div>
  )
}

/**
 * Glifos em pixel, na linguagem da iconografia Nimber (grade 5×5).
 * Usados em estados vazios e na marca — os ícones de interface continuam sendo de traço (Lucide).
 */
const PIXEL: Record<string, string[]> = {
  mark: ['x...x', '.x.x.', '..x..', '.x.x.', 'x...x'],
  empty: ['x.x.x', '.....', 'x...x', '.....', 'x.x.x'],
  chat: ['xxxxx', 'x...x', 'x...x', 'xxx.x', 'x....'],
  flow: ['xx...', 'x.x..', '.xxx.', '..x.x', '...xx'],
  ai: ['.x.x.', 'xxxxx', '.x.x.', 'xxxxx', '.x.x.'],
  lock: ['.xxx.', '.x.x.', 'xxxxx', 'xx.xx', 'xxxxx'],
  rise: ['..x..', '.xxx.', 'x.x.x', '..x..', '..x..'],
}

export function PixelGlyph({ pattern, size = 24, className }: { pattern: keyof typeof PIXEL | string; size?: number; className?: string }) {
  const rows = PIXEL[pattern] ?? PIXEL.empty!
  return (
    <svg width={size} height={size} viewBox="0 0 5 5" className={className} aria-hidden shapeRendering="crispEdges">
      {rows.flatMap((row, y) => [...row].map((c, x) => (c === 'x' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" /> : null)))}
    </svg>
  )
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink">
      <PixelGlyph pattern="mark" size={compact ? 22 : 20} className="text-coral" />
      {!compact && (
        <span className="leading-none">
          <span className="font-semibold tracking-tight">Nimber</span> <span className="text-muted">Atende</span>
        </span>
      )}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-panel-2 px-1 text-[11px] font-medium text-muted">{children}</kbd>
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-[12px] border border-line bg-panel shadow-panel">
      <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-[28px] leading-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- diálogo
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,textarea,select,button[data-autofocus]')?.focus(), 30)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-core/45 p-4 pt-[10vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full rounded-[14px] border border-line bg-panel shadow-panel"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h2 className="font-display text-xl text-ink">{title}</h2>
            {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
          </div>
          <IconButton label="Fechar" onClick={onClose} className="-mr-2 -mt-1">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number | string }[] }) {
  return (
    <div className="flex gap-1 rounded-[9px] bg-panel-2 p-1" role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cx(
            'flex flex-1 items-center justify-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[13px] font-medium transition-colors',
            value === it.value ? 'bg-panel text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-muted hover:text-ink',
          )}
        >
          {it.label}
          {it.count !== undefined && Number(it.count) > 0 && (
            <span className={cx('rounded px-1 text-[11px]', value === it.value ? 'bg-coral text-white' : 'bg-line-strong text-ink-2')}>{it.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[12px] text-muted">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  )
}

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LogOut, MessagesSquare, Monitor, Moon, Settings, ShieldAlert, Sun, Users, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Avatar, cx, Logo } from '../components/ui'
import { api } from '../lib/api'
import { brandName } from '../lib/brand'
import { moduleOn, useSession, type ModuleKey } from '../lib/session'
import { getSocket } from '../lib/socket'
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { extraNav } from './nav.extra'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** só aparece com o módulo contratado */
  module?: ModuleKey
  show?: (role: string, perms: Record<string, boolean>) => boolean
}

const baseNav: NavItem[] = [
  { to: '/atendimento', label: 'Atendimento', icon: MessagesSquare },
  { to: '/contatos', label: 'Contatos', icon: Users },
]

/** Liga os eventos do servidor ao cache do React Query e às notificações do sistema operacional. */
function useRealtimeBridge() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { me } = useSession()
  useEffect(() => {
    if (!me) return
    const s = getSocket()
    const invalidateLists = () => {
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['counts'] })
    }
    const onConv = (conv: any) => {
      qc.setQueriesData({ queryKey: ['conversations'] }, (old: any) => {
        if (!Array.isArray(old)) return old
        const idx = old.findIndex((c: any) => c.id === conv.id)
        if (idx < 0) return old
        const copy = [...old]
        copy[idx] = conv
        return copy
      })
      qc.setQueryData(['conversation', conv.id], (old: any) => (old ? { ...old, ...conv } : old))
      throttledInvalidate()
    }
    let t: any = null
    const throttledInvalidate = () => {
      if (t) return
      t = setTimeout(() => {
        t = null
        invalidateLists()
      }, 700)
    }
    const onMsg = (m: any) => {
      qc.setQueryData(['messages', m.conversation_id], (old: any) => {
        if (!old) return old
        if (old.messages.some((x: any) => x.id === m.id)) return old
        return { ...old, messages: [...old.messages, m] }
      })
      if (m.direction === 'in' && document.hidden) maybeNotify('Nova mensagem', m.body ?? 'Mídia recebida', m.conversation_id)
    }
    const onStatus = (m: any) => {
      qc.setQueryData(['messages', m.conversation_id], (old: any) =>
        old ? { ...old, messages: old.messages.map((x: any) => (x.id === m.id ? { ...x, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) } : x)) } : old,
      )
    }
    const onEvent = (e: any) => {
      qc.setQueryData(['messages', e.conversation_id], (old: any) => (old ? { ...old, events: [...(old.events ?? []), e] } : old))
    }
    const maybeNotify = (title: string, body: string, conversationId?: string) => {
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          const n = new Notification(title, { body, icon: '/favicon.svg', tag: conversationId })
          n.onclick = () => {
            window.focus()
            ;(window as any).nimberDesktop?.focus?.()
            if (conversationId) navigate(`/atendimento/${conversationId}`)
          }
        }
      } catch {
        /* ignora */
      }
      ;(window as any).nimberDesktop?.badge?.()
    }
    const onNotify = (n: any) => {
      toast(n.title, { description: n.body, action: n.conversationId ? { label: 'Abrir', onClick: () => navigate(`/atendimento/${n.conversationId}`) } : undefined })
      maybeNotify(n.title, n.body, n.conversationId)
    }
    const onConnStatus = () => qc.invalidateQueries({ queryKey: ['connections'] })
    s.on('conversation:updated', onConv)
    s.on('message:new', onMsg)
    s.on('message:status', onStatus)
    s.on('conversation:event', onEvent)
    s.on('notify', onNotify)
    s.on('connection:status', onConnStatus)
    s.on('connect', invalidateLists)
    if ('Notification' in window && Notification.permission === 'default') {
      setTimeout(() => Notification.requestPermission().catch(() => {}), 3000)
    }
    const onVis = () => s.emit('presence', document.hidden ? 'away' : 'online')
    document.addEventListener('visibilitychange', onVis)
    return () => {
      s.off('conversation:updated', onConv)
      s.off('message:new', onMsg)
      s.off('message:status', onStatus)
      s.off('conversation:event', onEvent)
      s.off('notify', onNotify)
      s.off('connection:status', onConnStatus)
      s.off('connect', invalidateLists)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [me, qc, navigate])
}

function ConnectionDots() {
  const { data } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/api/connections'), refetchInterval: 60_000 })
  if (!data?.length) return null
  return (
    <div className="flex flex-col items-center gap-1.5" title="Conexões WhatsApp">
      {data
        .filter((c) => c.enabled)
        .map((c) => (
          <NavLink
            key={c.id}
            to="/configuracoes/conexoes"
            title={`${c.name}: ${c.status === 'connected' ? 'conectado' : c.status === 'qr' ? 'aguardando QR Code' : 'desconectado'}`}
            className={cx(
              'size-2.5 rounded-[2px]',
              c.status === 'connected' ? 'bg-ok' : c.status === 'connecting' || c.status === 'qr' ? 'animate-pulse bg-warn' : 'bg-coral',
            )}
          />
        ))}
    </div>
  )
}

function UserMenu() {
  const { me, logout } = useSession()
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<ThemePref>(getThemePref())
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  if (!me) return null
  const themes: { v: ThemePref; icon: LucideIcon; label: string }[] = [
    { v: 'light', icon: Sun, label: 'Claro' },
    { v: 'dark', icon: Moon, label: 'Escuro' },
    { v: 'system', icon: Monitor, label: 'Sistema' },
  ]
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="rounded-[10px] p-0.5 hover:ring-2 hover:ring-line-strong" aria-label="Menu do usuário">
        <Avatar name={me.user.name} color={me.user.color} size={34} />
      </button>
      {open && (
        <div className="absolute bottom-0 left-12 z-40 w-64 rounded-[12px] border border-line bg-panel p-2 shadow-panel">
          <div className="px-2 py-2">
            <div className="font-medium text-ink">{me.user.name}</div>
            <div className="text-[12px] text-muted">{me.user.email}</div>
          </div>
          <div className="my-1 flex gap-1 rounded-[8px] bg-panel-2 p-1">
            {themes.map((t) => (
              <button
                key={t.v}
                onClick={() => {
                  setThemePref(t.v)
                  setTheme(t.v)
                }}
                className={cx('flex flex-1 items-center justify-center gap-1 rounded-[6px] py-1 text-[12px]', theme === t.v ? 'bg-panel text-ink' : 'text-muted')}
              >
                <t.icon className="size-3.5" /> {t.label}
              </button>
            ))}
          </div>
          <NavLink to="/configuracoes/perfil" onClick={() => setOpen(false)} className="block rounded-[8px] px-2 py-2 text-sm text-ink-2 hover:bg-panel-2">
            Meu perfil e segurança
          </NavLink>
          <button onClick={() => void logout()} className="flex w-full items-center gap-2 rounded-[8px] px-2 py-2 text-left text-sm text-coral-ink hover:bg-coral-soft">
            <LogOut className="size-4" /> Sair
          </button>
        </div>
      )}
    </div>
  )
}

export function Shell() {
  const { me } = useSession()
  useRealtimeBridge()
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api.get<any>('/api/conversations/counts'), refetchInterval: 30_000 })
  const badge = Number(counts.data?.mine_unread ?? 0) + Number(counts.data?.queue ?? 0)
  useEffect(() => {
    document.title = badge > 0 ? `(${badge}) ${brandName()}` : brandName()
    ;(window as any).nimberDesktop?.setBadge?.(badge)
  }, [badge])
  if (!me) return null
  const nav = [...baseNav, ...extraNav, { to: '/configuracoes', label: 'Configurações', icon: Settings } as NavItem].filter(
    (n) => (!n.module || moduleOn(me, n.module)) && (!n.show || n.show(me.user.role, me.user.permissions as any)),
  )
  return (
    <div className="flex h-full flex-col">
      {me.impersonation && <ImpersonationBar imp={me.impersonation} />}
      <div className="flex min-h-0 flex-1">
      <aside className="flex w-[64px] shrink-0 flex-col items-center justify-between border-r border-line bg-panel py-4">
        <div className="flex flex-col items-center gap-5">
          <NavLink to="/atendimento" aria-label="Início">
            <Logo compact />
          </NavLink>
          <nav className="flex flex-col gap-1.5">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                title={n.label}
                aria-label={n.label}
                className={({ isActive }) =>
                  cx(
                    'relative flex size-10 items-center justify-center rounded-[10px] transition-colors',
                    isActive ? 'bg-navy text-linen dark:bg-linen dark:text-navy' : 'text-muted hover:bg-panel-2 hover:text-ink',
                  )
                }
              >
                <n.icon className="size-[19px]" strokeWidth={1.8} />
                {n.to === '/atendimento' && badge > 0 && (
                  <span className="absolute -right-1 -top-1 min-w-[18px] rounded-[5px] bg-coral px-1 text-center text-[10.5px] font-semibold leading-[18px] text-white">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex flex-col items-center gap-4">
          <ConnectionDots />
          <UserMenu />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      </div>
    </div>
  )
}

/** Faixa fixa enquanto a equipe do fornecedor está dentro do ambiente do cliente. */
function ImpersonationBar({ imp }: { imp: NonNullable<ReturnType<typeof useSession>['me']>['impersonation'] & {} }) {
  const { logout } = useSession()
  const until = new Date(imp.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="flex items-center gap-3 bg-navy px-4 py-1.5 text-[12.5px] text-linen dark:bg-linen dark:text-navy" role="status">
      <ShieldAlert className="size-4 shrink-0 text-coral" />
      <span className="min-w-0 truncate">
        <strong>Acesso do fornecedor</strong> — {imp.byName ?? 'equipe'}
        {imp.reason ? ` · ${imp.reason}` : ''} · válido até {until}. Tudo o que for feito fica registrado na auditoria.
      </span>
      <button className="ml-auto shrink-0 rounded-[6px] border border-linen/30 px-2 py-0.5 hover:bg-linen/10 dark:border-navy/30" onClick={() => void logout().then(() => window.close())}>
        Encerrar acesso
      </button>
    </div>
  )
}

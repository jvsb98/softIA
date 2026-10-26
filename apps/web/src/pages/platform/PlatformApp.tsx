import { Building2, Cpu, LogOut, ScrollText, UserCog, UsersRound, type LucideIcon } from 'lucide-react'
import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom'
import { Avatar, cx, Logo } from '../../components/ui'
import { useSession } from '../../lib/session'
import { AiProvidersSettings } from '../ai/AiSettings'
import { BootScreen, ChangePasswordPage, LoginPage, TwoFactorSetupPage } from '../auth/AuthPages'
import { AuditSettings, ProfileSettings } from '../settings/MiscSettings'
import { ClientPage } from './ClientPage'
import { ClientsPage } from './ClientsPage'
import { NewClientPage } from './NewClientPage'
import { ROLE_LABEL } from './shared'
import { TeamPage } from './TeamPage'

/** Painel do fornecedor: mesma tela de acesso (login + 2FA obrigatório), navegação própria. */
export function PlatformApp() {
  const { me, loading } = useSession()
  if (loading) return <BootScreen />
  if (!me) return <LoginPage />
  if (me.mfaSetupRequired) return <TwoFactorSetupPage mandatory />
  if (me.user.must_change_password) return <ChangePasswordPage />
  const isAdmin = me.user.role === 'admin'
  return (
    <Routes>
      <Route element={<PlatformShell />}>
        <Route index element={<Navigate to="/clientes" replace />} />
        <Route path="/clientes" element={<ClientsPage />} />
        <Route path="/clientes/novo" element={<NewClientPage />} />
        <Route path="/clientes/:id" element={<ClientPage />} />
        <Route path="/equipe" element={<TeamPage />} />
        {isAdmin && <Route path="/ia" element={<Page><AiProvidersSettings /></Page>} />}
        {isAdmin && <Route path="/auditoria" element={<Page><AuditSettings /></Page>} />}
        <Route path="/perfil" element={<Page><ProfileSettings /></Page>} />
        <Route path="*" element={<Navigate to="/clientes" replace />} />
      </Route>
    </Routes>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[960px] px-10 py-8">{children}</div>
}

function PlatformShell() {
  const { me, logout } = useSession()
  if (!me) return null
  const items: { to: string; label: string; icon: LucideIcon; show?: boolean }[] = [
    { to: '/clientes', label: 'Clientes', icon: Building2 },
    { to: '/equipe', label: 'Equipe', icon: UsersRound },
    { to: '/ia', label: 'IA (provedores e modelos)', icon: Cpu, show: me.user.role === 'admin' },
    { to: '/auditoria', label: 'Auditoria', icon: ScrollText, show: me.user.role === 'admin' },
    { to: '/perfil', label: 'Meu perfil e 2FA', icon: UserCog },
  ]
  return (
    <div className="flex h-full">
      <aside className="flex w-[240px] shrink-0 flex-col justify-between border-r border-line bg-panel px-3 py-5">
        <div>
          <div className="mb-1 px-3">
            <Logo />
          </div>
          <div className="mb-6 px-3 text-[12px] text-muted">Painel do fornecedor</div>
          <nav className="flex flex-col gap-0.5">
            {items
              .filter((i) => i.show !== false)
              .map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  className={({ isActive }) =>
                    cx('flex items-center gap-2.5 rounded-[8px] px-3 py-2 text-[13.5px]', isActive ? 'bg-navy text-linen dark:bg-linen dark:text-navy' : 'text-ink-2 hover:bg-panel-2')
                  }
                >
                  <i.icon className="size-4" strokeWidth={1.8} />
                  {i.label}
                </NavLink>
              ))}
          </nav>
        </div>
        <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5">
          <Avatar name={me.user.name} color={me.user.color} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink">{me.user.name}</div>
            <div className="text-[11.5px] text-muted">{ROLE_LABEL[me.user.role] ?? me.user.role}</div>
          </div>
          <button aria-label="Sair" title="Sair" className="rounded-[6px] p-1.5 text-muted hover:bg-panel-2 hover:text-ink" onClick={() => void logout()}>
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}

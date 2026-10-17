import type { ReactElement } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { cx } from '../../components/ui'
import { useSession } from '../../lib/session'
import { ConnectionsSettings } from './ConnectionsSettings'
import { AuditSettings, PacingSettings, ProfileSettings, QuickRepliesSettings, RetentionSettings, SecuritySettings, SystemSettings, TagsSettings } from './MiscSettings'
import { SectorsSettings } from './SectorsSettings'
import { settingsExtras } from './settings.extra'
import { UsersSettings } from './UsersSettings'

export interface SettingsItem {
  path: string
  label: string
  group: string
  roles: ('admin' | 'supervisor' | 'agent')[]
  element: ReactElement
}

const base: SettingsItem[] = [
  { path: 'perfil', label: 'Meu perfil e segurança', group: 'Pessoal', roles: ['admin', 'supervisor', 'agent'], element: <ProfileSettings /> },
  { path: 'conexoes', label: 'Conexões WhatsApp', group: 'Atendimento', roles: ['admin', 'supervisor'], element: <ConnectionsSettings /> },
  { path: 'setores', label: 'Setores e horários', group: 'Atendimento', roles: ['admin', 'supervisor'], element: <SectorsSettings /> },
  { path: 'usuarios', label: 'Usuários', group: 'Atendimento', roles: ['admin', 'supervisor'], element: <UsersSettings /> },
  { path: 'respostas', label: 'Respostas rápidas', group: 'Atendimento', roles: ['admin', 'supervisor', 'agent'], element: <QuickRepliesSettings /> },
  { path: 'etiquetas', label: 'Etiquetas', group: 'Atendimento', roles: ['admin', 'supervisor'], element: <TagsSettings /> },
  { path: 'envio', label: 'Ritmo de envio', group: 'Proteção do número', roles: ['admin'], element: <PacingSettings /> },
  { path: 'seguranca', label: 'Política de acesso', group: 'Segurança e LGPD', roles: ['admin'], element: <SecuritySettings /> },
  { path: 'retencao', label: 'Retenção de dados', group: 'Segurança e LGPD', roles: ['admin'], element: <RetentionSettings /> },
  { path: 'auditoria', label: 'Auditoria', group: 'Segurança e LGPD', roles: ['admin'], element: <AuditSettings /> },
  { path: 'sistema', label: 'Saúde do sistema', group: 'Sistema', roles: ['admin', 'supervisor'], element: <SystemSettings /> },
]

export function SettingsPage() {
  const { me } = useSession()
  const role = me!.user.role
  const items = [...base, ...settingsExtras].filter((i) => i.roles.includes(role))
  const groups = [...new Set(items.map((i) => i.group))]
  return (
    <div className="flex h-full">
      <nav className="w-[248px] shrink-0 overflow-y-auto border-r border-line bg-panel px-3 py-6">
        <h1 className="mb-5 px-3 font-display text-[22px] text-ink">Configurações</h1>
        {groups.map((g) => (
          <div key={g} className="mb-4">
            <div className="px-3 pb-1 text-[12px] font-medium text-muted">{g}</div>
            {items
              .filter((i) => i.group === g)
              .map((i) => (
                <NavLink
                  key={i.path}
                  to={`/configuracoes/${i.path}`}
                  className={({ isActive }) => cx('block rounded-[8px] px-3 py-1.5 text-[13.5px]', isActive ? 'bg-panel-2 font-medium text-ink' : 'text-ink-2 hover:bg-panel-2/60')}
                >
                  {i.label}
                </NavLink>
              ))}
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
        <div className="mx-auto max-w-[920px]">
          <Routes>
            {items.map((i) => (
              <Route key={i.path} path={i.path} element={i.element} />
            ))}
            <Route path="*" element={<Navigate to={role === 'agent' ? 'perfil' : 'conexoes'} replace />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}

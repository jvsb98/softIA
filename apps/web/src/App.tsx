import { useQuery } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from './lib/api'
import { useBrand } from './lib/brand'
import { useSession } from './lib/session'
import { Shell } from './layout/Shell'
import { BootScreen, ChangePasswordPage, LoginPage, SetupPage, TwoFactorSetupPage } from './pages/auth/AuthPages'
import { InboxPage } from './pages/inbox/InboxPage'
import { ContactsPage } from './pages/inbox/ContactsPage'
import { PlatformApp } from './pages/platform/PlatformApp'
import { SettingsPage } from './pages/settings/SettingsPage'
import { extraRoutes } from './routes.extra'

/** O hostname decide: painel do fornecedor (plataforma) ou ambiente de um cliente. */
export default function App() {
  const brand = useBrand()
  if (brand.isLoading) return <BootScreen />
  return brand.data?.scope === 'platform' ? <PlatformApp /> : <TenantApp />
}

function TenantApp() {
  const { me, loading } = useSession()
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean }>('/api/setup/status'), staleTime: Infinity })

  if (loading || setup.isLoading) return <BootScreen />
  if (setup.data?.needsSetup && !me) return <SetupPage />
  if (!me) return <LoginPage />
  if (me.mfaSetupRequired) return <TwoFactorSetupPage mandatory />
  if (me.user.must_change_password && !me.impersonation) return <ChangePasswordPage />

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/atendimento" replace />} />
        <Route path="/atendimento" element={<InboxPage />} />
        <Route path="/atendimento/:conversationId" element={<InboxPage />} />
        <Route path="/contatos" element={<ContactsPage />} />
        <Route path="/configuracoes/*" element={<SettingsPage />} />
        {extraRoutes()}
        <Route path="*" element={<Navigate to="/atendimento" replace />} />
      </Route>
    </Routes>
  )
}

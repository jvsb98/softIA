import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { api, ApiError } from './api'
import { resetSocket } from './socket'

export type ModuleKey = 'atendimento' | 'crm' | 'agenda' | 'fluxos' | 'ia' | 'disparo' | 'relatorios' | 'integracoes'

export interface Me {
  scope: 'tenant' | 'platform'
  user: {
    id: string
    name: string
    email: string
    /** cliente: admin, supervisor, agent · painel do fornecedor: admin (super admin), implantador, suporte */
    role: 'admin' | 'supervisor' | 'agent' | 'implantador' | 'suporte'
    permissions: { flowsAdvanced: boolean; flowsEdit: boolean; flowsCreate?: boolean; kbEdit: boolean; reports: boolean }
    totp_enabled: boolean
    must_change_password: boolean
    color: string
    signature: string | null
    sectorIds: string[]
  }
  mfaSetupRequired: boolean
  org: { name: string }
  /** módulos contratados (só no ambiente do cliente) */
  modules: Record<ModuleKey, { on: boolean; config: Record<string, any> }> | null
  limits: Record<string, any> | null
  /** sessão aberta pela equipe do fornecedor ("entrar como cliente") */
  impersonation: { byName: string | null; reason: string | null; expiresAt: string } | null
}

/** Módulo ligado no ambiente atual (no painel do fornecedor, tudo vale). */
export const moduleOn = (me: Me | null | undefined, key: ModuleKey) => !me?.modules || !!me.modules[key]?.on

type SessionCtx = { me: Me | null; loading: boolean; refresh: () => Promise<unknown>; logout: () => Promise<void> }
// Sem valor padrão: ler a sessão fora do SessionProvider (ou numa cópia duplicada deste módulo no build)
// precisa virar um erro visível, nunca uma sessão vazia silenciosa (que deixava a tela em branco).
const Ctx = createContext<SessionCtx | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/api/auth/me')
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 60_000,
    retry: false,
  })
  useEffect(() => {
    const onUnauth = () => qc.setQueryData(['me'], null)
    window.addEventListener('na:unauthorized', onUnauth)
    return () => window.removeEventListener('na:unauthorized', onUnauth)
  }, [qc])

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {})
    resetSocket()
    qc.clear()
    qc.setQueryData(['me'], null)
  }
  return <Ctx.Provider value={{ me: query.data ?? null, loading: query.isLoading, refresh: () => query.refetch(), logout }}>{children}</Ctx.Provider>
}

export const useSession = (): SessionCtx => {
  const v = useContext(Ctx)
  if (!v) throw new Error('Sessão indisponível: componente fora do SessionProvider ou módulo de sessão duplicado no build.')
  return v
}
export const useMe = () => {
  const { me } = useSession()
  if (!me) throw new Error('Sem sessão')
  return me
}

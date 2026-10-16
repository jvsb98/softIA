import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { api, ApiError } from './api'
import { resetSocket } from './socket'

export interface Me {
  user: {
    id: string
    name: string
    email: string
    role: 'admin' | 'supervisor' | 'agent'
    permissions: { flowsAdvanced: boolean; flowsEdit: boolean; kbEdit: boolean; reports: boolean }
    totp_enabled: boolean
    must_change_password: boolean
    color: string
    signature: string | null
    sectorIds: string[]
  }
  mfaSetupRequired: boolean
  org: { name: string }
}

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<unknown>; logout: () => Promise<void> }>({
  me: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
})

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

export const useSession = () => useContext(Ctx)
export const useMe = () => {
  const { me } = useSession()
  if (!me) throw new Error('Sem sessão')
  return me
}

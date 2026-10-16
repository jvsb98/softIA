import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export const useSectors = () => useQuery({ queryKey: ['sectors'], queryFn: () => api.get<any[]>('/api/sectors'), staleTime: 60_000 })
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api.get<any[]>('/api/users'), staleTime: 60_000 })
export const useConnections = () => useQuery({ queryKey: ['connections'], queryFn: () => api.get<any[]>('/api/connections'), staleTime: 15_000 })
export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: () => api.get<any[]>('/api/tags'), staleTime: 60_000 })
export const useQuickReplies = () => useQuery({ queryKey: ['quick-replies'], queryFn: () => api.get<any[]>('/api/quick-replies'), staleTime: 60_000 })

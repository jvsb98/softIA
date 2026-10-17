import { BarChart3, BookOpen, Workflow } from 'lucide-react'
import type { NavItem } from './Shell'

/** Itens de navegação dos módulos das fases seguintes. */
export const extraNav: NavItem[] = [
  { to: '/fluxos', label: 'Fluxos', icon: Workflow, show: (role, p) => role !== 'agent' || !!p.flowsEdit },
  { to: '/conhecimento', label: 'Base de conhecimento', icon: BookOpen },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, show: (role, p) => role !== 'agent' || !!p.reports },
]

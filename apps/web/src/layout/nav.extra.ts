import { BarChart3, BookOpen, Workflow } from 'lucide-react'
import type { NavItem } from './Shell'

/** Itens de navegação dos módulos das fases seguintes. */
export const extraNav: NavItem[] = [
  { to: '/fluxos', label: 'Fluxos', icon: Workflow, module: 'fluxos', show: (role, p) => role !== 'agent' || !!p.flowsEdit },
  { to: '/conhecimento', label: 'Base de conhecimento', icon: BookOpen, module: 'ia' },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, module: 'relatorios', show: (role, p) => role !== 'agent' || !!p.reports },
]

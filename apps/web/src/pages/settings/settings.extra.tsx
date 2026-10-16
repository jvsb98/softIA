import { AgentSettings, AiProvidersSettings, ComplianceSettings, HandoffSettings, QualificationSettings } from '../ai/AiSettings'
import type { SettingsItem } from './SettingsPage'

/** Páginas de configuração das fases seguintes (IA, compliance, integrações). */
export const settingsExtras: SettingsItem[] = [
  { path: 'ia', label: 'Provedores e modelos', group: 'Inteligência artificial', roles: ['admin'], element: <AiProvidersSettings /> },
  { path: 'agente', label: 'Agente de IA', group: 'Inteligência artificial', roles: ['admin'], element: <AgentSettings /> },
  { path: 'qualificacao', label: 'Qualificação de leads', group: 'Inteligência artificial', roles: ['admin', 'supervisor'], element: <QualificationSettings /> },
  { path: 'transferencia', label: 'Transferência para humano', group: 'Inteligência artificial', roles: ['admin'], element: <HandoffSettings /> },
  { path: 'compliance', label: 'Compliance', group: 'Inteligência artificial', roles: ['admin'], element: <ComplianceSettings /> },
]

import { AgentSettings, AiProvidersSettings, ComplianceSettings, HandoffSettings, QualificationSettings } from '../ai/AiSettings'
import { AlertsSettings, DataSourcesSettings, FollowupsSettings, HolidaysSettings, WebhooksSettings } from '../integrations/IntegrationsSettings'
import type { SettingsItem } from './SettingsPage'

/** Páginas de configuração das fases seguintes (IA, compliance, integrações). */
export const settingsExtras: SettingsItem[] = [
  { path: 'ia', label: 'Provedores e modelos', group: 'Inteligência artificial', roles: ['admin'], element: <AiProvidersSettings /> },
  { path: 'agente', label: 'Agente de IA', group: 'Inteligência artificial', roles: ['admin'], element: <AgentSettings /> },
  { path: 'qualificacao', label: 'Qualificação de leads', group: 'Inteligência artificial', roles: ['admin', 'supervisor'], element: <QualificationSettings /> },
  { path: 'transferencia', label: 'Transferência para humano', group: 'Inteligência artificial', roles: ['admin'], element: <HandoffSettings /> },
  { path: 'compliance', label: 'Compliance', group: 'Inteligência artificial', roles: ['admin'], element: <ComplianceSettings /> },
  { path: 'followups', label: 'Follow-ups', group: 'Atendimento', roles: ['admin', 'supervisor'], element: <FollowupsSettings /> },
  { path: 'feriados', label: 'Feriados', group: 'Atendimento', roles: ['admin', 'supervisor'], element: <HolidaysSettings /> },
  { path: 'consultas', label: 'Consultas a outras bases', group: 'Integrações', roles: ['admin'], element: <DataSourcesSettings /> },
  { path: 'webhooks', label: 'Webhooks', group: 'Integrações', roles: ['admin'], element: <WebhooksSettings /> },
  { path: 'alertas', label: 'Alertas no Slack', group: 'Integrações', roles: ['admin'], element: <AlertsSettings /> },
]

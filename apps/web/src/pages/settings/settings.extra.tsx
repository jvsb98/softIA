import { AgentSettings, ComplianceSettings, HandoffSettings, QualificationSettings } from '../ai/AiSettings'
import { AlertsSettings, DataSourcesSettings, FollowupsSettings, HolidaysSettings, WebhooksSettings } from '../integrations/IntegrationsSettings'
import type { SettingsItem } from './SettingsPage'

/** Páginas de configuração das fases seguintes (IA, compliance, integrações). */
export const settingsExtras: SettingsItem[] = [
  // Provedores e modelos de IA ficam no painel do fornecedor (chaves da plataforma)
  { path: 'agente', label: 'Agente de IA', group: 'Inteligência artificial', roles: ['admin'], module: 'ia', element: <AgentSettings /> },
  { path: 'qualificacao', label: 'Qualificação de leads', group: 'Inteligência artificial', roles: ['admin', 'supervisor'], module: 'ia', element: <QualificationSettings /> },
  { path: 'transferencia', label: 'Transferência para humano', group: 'Inteligência artificial', roles: ['admin'], module: 'ia', element: <HandoffSettings /> },
  { path: 'compliance', label: 'Compliance', group: 'Fornecedor', roles: ['admin'], platformOnly: true, element: <ComplianceSettings /> },
  { path: 'followups', label: 'Follow-ups', group: 'Atendimento', roles: ['admin', 'supervisor'], element: <FollowupsSettings /> },
  { path: 'feriados', label: 'Feriados', group: 'Atendimento', roles: ['admin', 'supervisor'], element: <HolidaysSettings /> },
  { path: 'consultas', label: 'Consultas a outras bases', group: 'Fornecedor', roles: ['admin'], platformOnly: true, element: <DataSourcesSettings /> },
  { path: 'webhooks', label: 'Webhooks', group: 'Integrações', roles: ['admin'], module: 'integracoes', element: <WebhooksSettings /> },
  { path: 'alertas', label: 'Alertas no Slack', group: 'Integrações', roles: ['admin'], module: 'integracoes', element: <AlertsSettings /> },
]

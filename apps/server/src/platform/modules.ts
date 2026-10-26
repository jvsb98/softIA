/**
 * Catálogo de módulos, planos de referência e limites de cada cliente.
 *
 * - Módulo "base" vale para todo cliente; os demais o fornecedor liga ou desliga no painel.
 * - Uma função só aparece para o cliente quando o módulo está ligado E o papel do usuário permite.
 *   O servidor confere as duas em cada rota (ver http/app.ts), não só o menu.
 * - "available: false" = ainda não construído (chega numa fase seguinte); aparece no painel como "em breve".
 */
import { tenantOrNull, type TenantCtx } from '../lib/tenant.js'

export type ModuleKey = 'atendimento' | 'crm' | 'agenda' | 'fluxos' | 'ia' | 'disparo' | 'relatorios' | 'integracoes'
export type FlowEditMode = 'fornecedor' | 'cliente_edita' | 'cliente_cria'

export interface ModuleDef {
  key: ModuleKey
  label: string
  description: string
  base: boolean
  available: boolean
  phase?: string
}

export const MODULES: ModuleDef[] = [
  { key: 'atendimento', label: 'Atendimento', base: true, available: true, description: 'Inbox, contatos, setores, etiquetas, respostas rápidas, horários e conexões por QR Code' },
  { key: 'crm', label: 'CRM', base: true, available: false, phase: 'Fase 4', description: 'Funil kanban, responsável, valor, próximo contato e histórico' },
  { key: 'agenda', label: 'Agenda', base: true, available: false, phase: 'Fase 3', description: 'Profissionais, serviços, Google e Microsoft, lembretes' },
  { key: 'fluxos', label: 'Fluxos', base: false, available: true, description: 'Fluxos de atendimento automático (o fornecedor define quem edita)' },
  { key: 'ia', label: 'IA', base: false, available: true, description: 'Agente de IA, base de conhecimento, qualificação e nós de IA nos fluxos' },
  { key: 'disparo', label: 'Disparo', base: false, available: false, phase: 'Fase 5', description: 'Campanhas para listas pela Z-API' },
  { key: 'relatorios', label: 'Relatórios', base: false, available: true, description: 'Relatórios por setor, atendente, fluxo e IA' },
  { key: 'integracoes', label: 'Integrações', base: false, available: true, description: 'Webhooks e alertas no Slack' },
]

export interface ModuleState {
  enabled: boolean
  config: Record<string, any>
}

export interface TenantLimits {
  /** números de WhatsApp conectados */
  maxConnections: number
  /** usuários ativos (o acesso técnico do fornecedor não conta) */
  maxUsers: number
  /** profissionais na agenda (Fase 3) */
  maxProfessionals: number
  /** franquia mensal de tokens de IA (entrada + saída); 0 = sem franquia definida */
  aiTokensMonth: number
  /** ao estourar a franquia: bloquear a IA ou só avisar o fornecedor */
  aiOverage: 'bloquear' | 'avisar'
}

export const DEFAULT_LIMITS: TenantLimits = { maxConnections: 1, maxUsers: 3, maxProfessionals: 3, aiTokensMonth: 0, aiOverage: 'bloquear' }

export interface PlanPreset {
  key: string
  label: string
  description: string
  modules: Partial<Record<ModuleKey, ModuleState>>
  limits: TenantLimits
}

/** Planos de referência: só atalhos para preencher a criação. Cada cliente é ajustado depois, item a item. */
export const PLAN_PRESETS: PlanPreset[] = [
  {
    key: 'essencial',
    label: 'Essencial',
    description: 'Atendimento, CRM, agenda e fluxos montados pelo fornecedor',
    modules: { fluxos: { enabled: true, config: { edicao: 'fornecedor' } } },
    limits: { maxConnections: 1, maxUsers: 3, maxProfessionals: 3, aiTokensMonth: 0, aiOverage: 'bloquear' },
  },
  {
    key: 'profissional',
    label: 'Profissional',
    description: 'Essencial + o cliente edita os fluxos, IA com franquia e relatórios',
    modules: {
      fluxos: { enabled: true, config: { edicao: 'cliente_edita' } },
      ia: { enabled: true, config: {} },
      relatorios: { enabled: true, config: {} },
    },
    limits: { maxConnections: 2, maxUsers: 6, maxProfessionals: 8, aiTokensMonth: 1_000_000, aiOverage: 'bloquear' },
  },
  {
    key: 'completo',
    label: 'Completo',
    description: 'Profissional + disparo e integrações',
    modules: {
      fluxos: { enabled: true, config: { edicao: 'cliente_cria' } },
      ia: { enabled: true, config: {} },
      relatorios: { enabled: true, config: {} },
      disparo: { enabled: true, config: {} },
      integracoes: { enabled: true, config: {} },
    },
    limits: { maxConnections: 3, maxUsers: 10, maxProfessionals: 15, aiTokensMonth: 3_000_000, aiOverage: 'avisar' },
  },
]

const defOf = (key: ModuleKey) => MODULES.find((m) => m.key === key)

/** Módulo ligado para o cliente? Base vale sempre; os demais dependem do que o fornecedor ligou. */
export function isModuleOn(t: Pick<TenantCtx, 'modules'> | null | undefined, key: ModuleKey): boolean {
  const def = defOf(key)
  if (!def) return false
  if (def.base) return true
  return !!t?.modules?.[key]?.enabled
}

/** Atalho para o cliente do contexto atual (fora de um cliente, a plataforma tem tudo). */
export function moduleOn(key: ModuleKey): boolean {
  const t = tenantOrNull()
  return t ? isModuleOn(t, key) : true
}

export function flowEditMode(t: Pick<TenantCtx, 'modules'> | null | undefined): FlowEditMode {
  const m = t?.modules?.fluxos?.config?.edicao
  return m === 'cliente_edita' || m === 'cliente_cria' ? m : 'fornecedor'
}

export function limitsOf(t: Pick<TenantCtx, 'limits'> | null | undefined): TenantLimits {
  return { ...DEFAULT_LIMITS, ...(t?.limits ?? {}) }
}

/** Estado completo (todos os módulos do catálogo) para telas e para /api/auth/me. */
export function modulesView(t: Pick<TenantCtx, 'modules'> | null | undefined) {
  return Object.fromEntries(MODULES.map((m) => [m.key, { on: isModuleOn(t, m.key), config: t?.modules?.[m.key]?.config ?? {} }]))
}

/**
 * Modelos prontos de fluxo para ninguém começar do zero.
 */
import type { FlowDefinition } from './types.js'

const e = (source: string, target: string, sourceHandle = 'next') => ({ id: `e-${source}-${sourceHandle}-${target}`, source, sourceHandle, target })

export interface FlowTemplate {
  id: string
  name: string
  description: string
  build: (ids: { sdr?: string; closer?: string; suporte?: string }) => FlowDefinition
}

export const TEMPLATES: FlowTemplate[] = [
  {
    id: 'qualificacao-sdr',
    name: 'Entrada comercial com IA',
    description: 'Boas-vindas, menu rápido e o agente de IA qualificando. Qualificado vai para o Closer; dúvidas da conta vão para o Suporte.',
    build: (s) => ({
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 160 }, data: {} },
        { id: 'hours', type: 'business_hours', position: { x: 260, y: 160 }, data: { sectorId: s.sdr ?? '' } },
        {
          id: 'menu',
          type: 'menu',
          position: { x: 560, y: 40 },
          data: {
            text: 'Olá, {{contato.primeiro_nome}}! Aqui é a Nimber. Como posso te ajudar?',
            options: [
              { label: 'Quero conhecer as oportunidades de investimento', keywords: 'investir, conhecer, oportunidade, oferta' },
              { label: 'Já sou investidor e preciso de ajuda', keywords: 'conta, acesso, extrato, resgate, investidor' },
              { label: 'Falar com uma pessoa', keywords: 'atendente, pessoa, humano' },
            ],
            variable: 'assunto',
            maxRetries: 2,
          },
        },
        { id: 'agent', type: 'ai_agent', position: { x: 920, y: -60 }, data: { instructions: 'Entenda o interesse do contato e qualifique-o conforme os critérios.' } },
        { id: 'tq', type: 'transfer', position: { x: 1260, y: -160 }, data: { sectorId: s.closer ?? '', reason: 'Lead qualificado pelo agente (score {{ia_score}})', priority: '2' } },
        { id: 'th', type: 'transfer', position: { x: 1260, y: 20 }, data: { sectorId: '', reason: '{{ia_motivo}}', priority: '1' } },
        { id: 'tsup', type: 'transfer', position: { x: 920, y: 160 }, data: { sectorId: s.suporte ?? '', reason: 'Investidor pediu ajuda pelo menu', message: 'Certo! Vou te encaminhar para o nosso suporte ao investidor.' } },
        { id: 'tsdr', type: 'transfer', position: { x: 920, y: 320 }, data: { sectorId: s.sdr ?? '', reason: 'Pediu para falar com uma pessoa (menu)', message: 'Claro! Um especialista vai falar com você em instantes.' } },
        { id: 'off', type: 'transfer', position: { x: 560, y: 360 }, data: { sectorId: s.sdr ?? '', reason: 'Contato chegou fora do horário' } },
        { id: 'endq', type: 'end', position: { x: 1260, y: 180 }, data: {} },
      ],
      edges: [
        e('start', 'hours'),
        e('hours', 'menu', 'open'),
        e('hours', 'off', 'closed'),
        e('menu', 'agent', 'opt_0'),
        e('menu', 'tsup', 'opt_1'),
        e('menu', 'tsdr', 'opt_2'),
        e('menu', 'agent', 'invalid'),
        e('agent', 'tq', 'qualified'),
        e('agent', 'th', 'handoff'),
        e('agent', 'th', 'error'),
        e('agent', 'endq', 'disqualified'),
      ],
    }),
  },
  {
    id: 'triagem-suporte',
    name: 'Triagem de suporte ao investidor',
    description: 'A IA classifica o assunto (acesso, rendimentos, resgate, outro) e encaminha com o motivo já preenchido.',
    build: (s) => ({
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 120 }, data: {} },
        { id: 'hello', type: 'message', position: { x: 240, y: 120 }, data: { text: 'Olá, {{contato.primeiro_nome}}! Você está falando com o suporte ao investidor da Nimber.' } },
        {
          id: 'cls',
          type: 'ai_classify',
          position: { x: 520, y: 120 },
          data: {
            variable: 'assunto',
            categories: [
              { name: 'acesso', description: 'Login, senha, cadastro, verificação de identidade' },
              { name: 'rendimentos', description: 'Extrato, rendimentos, distribuição, tokens na carteira' },
              { name: 'resgate', description: 'Resgate, saque, venda de tokens, cancelamento' },
            ],
          },
        },
        { id: 'q', type: 'question', position: { x: 820, y: 280 }, data: { text: 'Pode me contar em poucas palavras o que aconteceu?', variable: 'detalhe', validation: 'any', maxRetries: 1 } },
        { id: 't', type: 'transfer', position: { x: 1120, y: 120 }, data: { sectorId: s.suporte ?? '', reason: 'Suporte — assunto: {{assunto}} {{detalhe}}', message: 'Obrigado! Já encaminhei para um especialista do suporte.' } },
        { id: 'tr', type: 'transfer', position: { x: 820, y: -40 }, data: { sectorId: s.suporte ?? '', reason: 'Resgate/saque — prioridade', priority: '2', message: 'Entendi. Vou passar agora para um especialista do suporte.' } },
      ],
      edges: [e('start', 'hello'), e('hello', 'cls'), e('cls', 'tr', 'cat_2'), e('cls', 't', 'cat_0'), e('cls', 't', 'cat_1'), e('cls', 'q', 'other'), e('q', 't', 'next'), e('q', 't', 'invalid')],
    }),
  },
  {
    id: 'cadastro-rapido',
    name: 'Cadastro rápido do lead',
    description: 'Pergunta nome e e-mail com validação, grava no contato e entrega para o SDR.',
    build: (s) => ({
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 100 }, data: {} },
        { id: 'qn', type: 'question', position: { x: 240, y: 100 }, data: { text: 'Olá! Para começar, qual é o seu nome?', variable: 'nome', validation: 'text' } },
        { id: 'qe', type: 'question', position: { x: 520, y: 100 }, data: { text: 'Prazer, {{nome}}! Qual é o seu melhor e-mail?', variable: 'email', validation: 'email', retryMessage: 'Esse e-mail parece incompleto. Pode conferir?' } },
        { id: 'up', type: 'update_contact', position: { x: 800, y: 100 }, data: { name: '{{nome}}', email: '{{email}}', leadStatus: 'em_qualificacao' } },
        { id: 't', type: 'transfer', position: { x: 1080, y: 100 }, data: { sectorId: s.sdr ?? '', reason: 'Cadastro rápido concluído', message: 'Obrigado, {{nome}}! Um especialista vai continuar por aqui.' } },
      ],
      edges: [e('start', 'qn'), e('qn', 'qe', 'next'), e('qn', 'qe', 'invalid'), e('qe', 'up', 'next'), e('qe', 'up', 'invalid'), e('up', 't')],
    }),
  },
]

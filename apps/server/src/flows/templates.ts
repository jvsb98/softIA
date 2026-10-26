/**
 * Modelos prontos de fluxo para ninguém começar do zero.
 */
import type { FlowDefinition } from './types.js'

const e = (source: string, target: string, sourceHandle = 'next') => ({ id: `e-${source}-${sourceHandle}-${target}`, source, sourceHandle, target })

export interface FlowTemplate {
  id: string
  name: string
  description: string
  build: (ids: Record<string, string | undefined>) => FlowDefinition
}

export const TEMPLATES: FlowTemplate[] = [
  {
    id: 'entrada-comercial',
    name: 'Entrada comercial com IA',
    description: 'Boas-vindas, menu rápido e o agente de IA entendendo o pedido. Qualificado vai para o Comercial; quem já é cliente vai para o Suporte.',
    build: (s) => ({
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 160 }, data: {} },
        { id: 'hours', type: 'business_hours', position: { x: 260, y: 160 }, data: { sectorId: s.atendimento ?? '' } },
        {
          id: 'menu',
          type: 'menu',
          position: { x: 560, y: 40 },
          data: {
            text: 'Olá, {{contato.primeiro_nome}}! Como posso te ajudar?',
            options: [
              { label: 'Quero um orçamento ou agendar', keywords: 'orçamento, preço, valor, agendar, marcar, horário' },
              { label: 'Já sou cliente e preciso de ajuda', keywords: 'cliente, pedido, instalação, retorno, ajuda' },
              { label: 'Falar com uma pessoa', keywords: 'atendente, pessoa, humano' },
            ],
            variable: 'assunto',
            maxRetries: 2,
          },
        },
        { id: 'agent', type: 'ai_agent', position: { x: 920, y: -60 }, data: { instructions: 'Entenda o que o contato precisa e colete as informações dos critérios.' } },
        { id: 'tq', type: 'transfer', position: { x: 1260, y: -160 }, data: { sectorId: s.comercial ?? '', reason: 'Lead qualificado pelo agente (score {{ia_score}})', priority: '2' } },
        { id: 'th', type: 'transfer', position: { x: 1260, y: 20 }, data: { sectorId: '', reason: '{{ia_motivo}}', priority: '1' } },
        { id: 'tsup', type: 'transfer', position: { x: 920, y: 160 }, data: { sectorId: s.suporte ?? '', reason: 'Cliente pediu ajuda pelo menu', message: 'Certo! Vou te encaminhar para o nosso suporte.' } },
        { id: 'tsdr', type: 'transfer', position: { x: 920, y: 320 }, data: { sectorId: s.atendimento ?? '', reason: 'Pediu para falar com uma pessoa (menu)', message: 'Claro! Alguém do nosso time vai falar com você em instantes.' } },
        { id: 'off', type: 'transfer', position: { x: 560, y: 360 }, data: { sectorId: s.atendimento ?? '', reason: 'Contato chegou fora do horário' } },
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
    name: 'Triagem de suporte ao cliente',
    description: 'A IA classifica o assunto (pedido, financeiro, reclamação, outro) e encaminha com o motivo já preenchido.',
    build: (s) => ({
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 120 }, data: {} },
        { id: 'hello', type: 'message', position: { x: 240, y: 120 }, data: { text: 'Olá, {{contato.primeiro_nome}}! Você está falando com o nosso suporte.' } },
        {
          id: 'cls',
          type: 'ai_classify',
          position: { x: 520, y: 120 },
          data: {
            variable: 'assunto',
            categories: [
              { name: 'pedido', description: 'Andamento de pedido, prazo, entrega, instalação ou agendamento' },
              { name: 'financeiro', description: 'Pagamento, boleto, nota fiscal, segunda via' },
              { name: 'reclamacao', description: 'Reclamação, defeito, problema no serviço, cancelamento' },
            ],
          },
        },
        { id: 'q', type: 'question', position: { x: 820, y: 280 }, data: { text: 'Pode me contar em poucas palavras o que aconteceu?', variable: 'detalhe', validation: 'any', maxRetries: 1 } },
        { id: 't', type: 'transfer', position: { x: 1120, y: 120 }, data: { sectorId: s.suporte ?? '', reason: 'Suporte — assunto: {{assunto}} {{detalhe}}', message: 'Obrigado! Já encaminhei para um especialista do suporte.' } },
        { id: 'tr', type: 'transfer', position: { x: 820, y: -40 }, data: { sectorId: s.suporte ?? '', reason: 'Reclamação — prioridade', priority: '2', message: 'Entendi. Vou passar agora para alguém do nosso suporte.' } },
      ],
      edges: [e('start', 'hello'), e('hello', 'cls'), e('cls', 'tr', 'cat_2'), e('cls', 't', 'cat_0'), e('cls', 't', 'cat_1'), e('cls', 'q', 'other'), e('q', 't', 'next'), e('q', 't', 'invalid')],
    }),
  },
  {
    id: 'cadastro-rapido',
    name: 'Cadastro rápido do lead',
    description: 'Pergunta nome e e-mail com validação, grava no contato e entrega para o Atendimento.',
    build: (s) => ({
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 100 }, data: {} },
        { id: 'qn', type: 'question', position: { x: 240, y: 100 }, data: { text: 'Olá! Para começar, qual é o seu nome?', variable: 'nome', validation: 'text' } },
        { id: 'qe', type: 'question', position: { x: 520, y: 100 }, data: { text: 'Prazer, {{nome}}! Qual é o seu melhor e-mail?', variable: 'email', validation: 'email', retryMessage: 'Esse e-mail parece incompleto. Pode conferir?' } },
        { id: 'up', type: 'update_contact', position: { x: 800, y: 100 }, data: { name: '{{nome}}', email: '{{email}}', leadStatus: 'em_qualificacao' } },
        { id: 't', type: 'transfer', position: { x: 1080, y: 100 }, data: { sectorId: s.atendimento ?? '', reason: 'Cadastro rápido concluído', message: 'Obrigado, {{nome}}! Alguém do nosso time vai continuar por aqui.' } },
      ],
      edges: [e('start', 'qn'), e('qn', 'qe', 'next'), e('qn', 'qe', 'invalid'), e('qe', 'up', 'next'), e('qe', 'up', 'invalid'), e('up', 't')],
    }),
  },
]

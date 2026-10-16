/**
 * Dados de demonstração para conhecer a interface sem conectar um número real.
 * Nomes e números são fictícios.
 */
import { one, q } from '../lib/db.js'

const people = [
  { name: 'Marina Albuquerque', phone: '5541988110001', status: 'em_qualificacao', score: 14, origin: 'Instagram — Hive SP' },
  { name: 'Rafael Couto', phone: '5511977220002', status: 'qualificado', score: 27, origin: 'Site — simulador' },
  { name: 'Beatriz Lemos', phone: '5541966330003', status: 'cliente', score: null, origin: 'Indicação' },
  { name: 'Otávio Prado', phone: '5521955440004', status: 'novo', score: null, origin: 'Google Ads' },
  { name: 'Lívia Tanaka', phone: '5541944550005', status: 'desqualificado', score: 6, origin: 'Instagram — Hive SP' },
]

const scripts: { status: string; sector: string; reason?: string; msgs: [('in' | 'out'), string, string?][] }[] = [
  {
    status: 'automation',
    sector: 'sdr',
    msgs: [
      ['in', 'Oi! Vi o anúncio do Hive SP. Como funciona investir com R$ 5 mil?'],
      ['out', 'Olá, Marina! Que bom ter você por aqui. No Hive SP você adquire frações tokenizadas de um ativo imobiliário, a partir de valores menores. Posso te fazer três perguntas rápidas para indicar o melhor caminho?', 'ai'],
      ['in', 'Pode sim'],
      ['out', 'Você já investe em renda fixa, fundos ou imóveis hoje?', 'ai'],
      ['in', 'Tenho CDB e um pouco em fundo imobiliário'],
    ],
  },
  {
    status: 'queued',
    sector: 'closer',
    reason: 'Lead qualificado (score 27) — quer falar com especialista',
    msgs: [
      ['in', 'Quero entender o contrato do Hive SP antes de aplicar 80 mil'],
      ['out', 'Perfeito, Rafael. Vou te conectar com um especialista do nosso time comercial agora.', 'ai'],
    ],
  },
  {
    status: 'open',
    sector: 'suporte',
    reason: 'Cliente com dúvida sobre a conta',
    msgs: [
      ['in', 'Boa tarde, não estou conseguindo ver meus tokens no app'],
      ['out', 'Boa tarde, Beatriz! Vou verificar com você. Você está acessando pelo app.nimber.com.br ou pelo celular?', 'agent'],
      ['in', 'Pelo celular'],
    ],
  },
  { status: 'queued', sector: 'sdr', reason: 'Pedido explícito para falar com uma pessoa', msgs: [['in', 'Prefiro falar com um atendente, por favor']] },
]

export async function seedDemo() {
  let conn = await one<any>(`SELECT id, name FROM connections WHERE name='Comercial (demonstração)'`)
  if (!conn) {
    conn = await one(
      `INSERT INTO connections(name, color, status, enabled, default_sector_id) VALUES ('Comercial (demonstração)','#FE5A51','disconnected', false,
        (SELECT id FROM sectors WHERE slug='sdr')) RETURNING id, name`,
    )
  }
  const admin = await one<any>(`SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1`)
  let n = 0
  for (let i = 0; i < scripts.length; i++) {
    const p = people[i]!
    const sc = scripts[i]!
    const c = await one<any>(
      `INSERT INTO contacts(name, push_name, phone, lead_status, score, origin, is_customer, last_interaction_at)
       VALUES ($1,$1,$2,$3,$4,$5,$6, now()) ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [p.name, p.phone, p.status, p.score, p.origin, p.status === 'cliente'],
    )
    const exists = await one(`SELECT 1 FROM conversations WHERE contact_id=$1 AND status<>'closed'`, [c.id])
    if (exists) continue
    const sector = await one<any>(`SELECT id FROM sectors WHERE slug=$1`, [sc.sector])
    const conv = await one<any>(
      `INSERT INTO conversations(connection_id, contact_id, status, sector_id, assignee_id, handoff_reason, queued_at, ai_paused, priority)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $3='queued' THEN now() - interval '7 minutes' END, $3<>'automation', $7) RETURNING id`,
      [conn.id, c.id, sc.status, sector?.id, sc.status === 'open' ? admin?.id : null, sc.reason ?? null, sc.status === 'queued' && i === 1 ? 2 : 0],
    )
    let t = Date.now() - sc.msgs.length * 90_000
    for (const [dir, body, who] of sc.msgs) {
      t += 60_000 + Math.floor(Math.random() * 40_000)
      await q(
        `INSERT INTO messages(conversation_id, connection_id, direction, sender_type, sender_user_id, kind, body, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'text',$6,$7, to_timestamp($8/1000.0))`,
        [conv.id, conn.id, dir, dir === 'in' ? 'contact' : (who ?? 'agent'), who === 'agent' ? admin?.id : null, body, dir === 'in' ? 'received' : 'read', t],
      )
    }
    const last = sc.msgs[sc.msgs.length - 1]!
    await q(
      `UPDATE conversations SET last_message_at=to_timestamp($2/1000.0), last_message_preview=$3, unread_count=$4, last_inbound_at=to_timestamp($2/1000.0) WHERE id=$1`,
      [conv.id, t, last[1].slice(0, 140), last[0] === 'in' && sc.status !== 'automation' ? 1 : 0],
    )
    if (sc.status === 'open') await q(`INSERT INTO conversation_events(conversation_id, type, actor_type, data) VALUES ($1,'conversation.assigned','system',$2)`, [conv.id, JSON.stringify({ user_name: 'Administrador' })])
    n++
  }
  return { connection: conn.name, conversations: n }
}

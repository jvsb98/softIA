import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { one, q } from '../../lib/db.js'
import { requirePermission } from '../app.js'

export async function reportRoutes(app: FastifyInstance) {
  app.get('/api/reports/overview', async (req) => {
    requirePermission(req, 'reports')
    const qs = z.object({ days: z.coerce.number().min(1).max(365).default(30), connectionId: z.string().uuid().optional() }).parse(req.query)
    const days = String(qs.days)
    const conn = qs.connectionId ?? null
    const tz = 'America/Sao_Paulo'

    const totals = await one<any>(
      `WITH c AS (SELECT * FROM conversations WHERE created_at > now() - ($1 || ' days')::interval AND ($2::uuid IS NULL OR connection_id=$2))
       SELECT count(*) AS conversations,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id=c.id AND e.type='conversation.transferred')) AS transferred,
              count(*) FILTER (WHERE status='closed' AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id=c.id AND e.type IN ('conversation.transferred','conversation.assigned'))) AS resolved_by_automation,
              count(*) FILTER (WHERE status <> 'closed') AS open_now,
              (SELECT count(*) FROM conversation_events e JOIN c ON c.id=e.conversation_id WHERE e.type='lead.qualified') AS qualified,
              (SELECT count(*) FROM conversation_events e JOIN c ON c.id=e.conversation_id WHERE e.type='lead.disqualified') AS disqualified,
              (SELECT count(*) FROM conversation_events e JOIN c ON c.id=e.conversation_id WHERE e.type='compliance.blocked') AS compliance_blocked,
              (SELECT count(*) FROM conversation_events e JOIN c ON c.id=e.conversation_id WHERE e.type='followup.sent') AS followups,
              round(extract(epoch FROM avg(assigned_at - queued_at) FILTER (WHERE assigned_at IS NOT NULL AND queued_at IS NOT NULL AND assigned_at >= queued_at)) / 60, 1) AS avg_wait_min,
              round(extract(epoch FROM avg(first_response_at - assigned_at) FILTER (WHERE first_response_at IS NOT NULL AND assigned_at IS NOT NULL AND first_response_at >= assigned_at)) / 60, 1) AS avg_first_response_min
         FROM c`,
      [days, conn],
    )

    const daily = await q<any>(
      `WITH d AS (SELECT generate_series((now() AT TIME ZONE $3)::date - ($1::int - 1), (now() AT TIME ZONE $3)::date, interval '1 day')::date AS day)
       SELECT to_char(d.day,'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM conversations c WHERE (c.created_at AT TIME ZONE $3)::date = d.day AND ($2::uuid IS NULL OR c.connection_id=$2)) AS conversations,
              (SELECT count(*) FROM conversation_events e JOIN conversations c ON c.id=e.conversation_id WHERE e.type='conversation.transferred' AND (e.created_at AT TIME ZONE $3)::date = d.day AND ($2::uuid IS NULL OR c.connection_id=$2)) AS transferred,
              (SELECT count(*) FROM conversation_events e JOIN conversations c ON c.id=e.conversation_id WHERE e.type='lead.qualified' AND (e.created_at AT TIME ZONE $3)::date = d.day AND ($2::uuid IS NULL OR c.connection_id=$2)) AS qualified
         FROM d ORDER BY d.day`,
      [qs.days, conn, tz],
    )

    const reasons = await q<any>(
      `SELECT coalesce(nullif(regexp_replace(e.data->>'reason', '\\(score \\d+\\)|: .*$', '', 'g'), ''), 'Sem motivo') AS reason, count(*) AS n
         FROM conversation_events e JOIN conversations c ON c.id=e.conversation_id
        WHERE e.type='conversation.transferred' AND e.created_at > now() - ($1 || ' days')::interval AND ($2::uuid IS NULL OR c.connection_id=$2)
        GROUP BY 1 ORDER BY n DESC LIMIT 8`,
      [days, conn],
    )

    const sectors = await q<any>(
      `SELECT s.id, s.name, s.color,
              (SELECT count(*) FROM conversations c WHERE c.sector_id=s.id AND c.status='queued') AS queued_now,
              (SELECT count(*) FROM conversations c WHERE c.sector_id=s.id AND c.status='open') AS open_now,
              (SELECT count(*) FROM conversations c WHERE c.sector_id=s.id AND c.created_at > now() - ($1 || ' days')::interval AND ($2::uuid IS NULL OR c.connection_id=$2)) AS conversations,
              (SELECT round(extract(epoch FROM avg(c.assigned_at - c.queued_at))/60, 1) FROM conversations c WHERE c.sector_id=s.id AND c.assigned_at >= c.queued_at AND c.created_at > now() - ($1 || ' days')::interval) AS avg_wait_min,
              (SELECT round(extract(epoch FROM avg(c.first_response_at - c.assigned_at))/60, 1) FROM conversations c WHERE c.sector_id=s.id AND c.first_response_at >= c.assigned_at AND c.created_at > now() - ($1 || ' days')::interval) AS avg_first_response_min
         FROM sectors s WHERE s.active ORDER BY s.sort`,
      [days, conn],
    )

    const agents = await q<any>(
      `SELECT u.id, u.name, u.color,
              count(DISTINCT e.conversation_id) FILTER (WHERE e.type='conversation.assigned') AS assigned,
              count(DISTINCT e.conversation_id) FILTER (WHERE e.type='conversation.closed' AND e.actor_id=u.id) AS closed,
              (SELECT count(*) FROM messages m WHERE m.sender_user_id=u.id AND m.direction='out' AND m.created_at > now() - ($1 || ' days')::interval) AS messages,
              (SELECT round(extract(epoch FROM avg(c.first_response_at - c.assigned_at))/60, 1) FROM conversations c WHERE c.assignee_id=u.id AND c.first_response_at >= c.assigned_at AND c.created_at > now() - ($1 || ' days')::interval) AS avg_first_response_min
         FROM users u LEFT JOIN conversation_events e
           ON ((e.data->>'user_id') = u.id::text OR e.actor_id = u.id) AND e.created_at > now() - ($1 || ' days')::interval
        WHERE u.active
        GROUP BY u.id ORDER BY assigned DESC NULLS LAST, u.name`,
      [days],
    )

    const funnel = await q<any>(
      `SELECT lead_status AS status, count(*) AS n FROM contacts
        WHERE created_at > now() - ($1 || ' days')::interval AND anonymized_at IS NULL GROUP BY 1`,
      [days],
    )

    const heat = await q<any>(
      `SELECT extract(isodow FROM created_at AT TIME ZONE $2)::int AS dow, extract(hour FROM created_at AT TIME ZONE $2)::int AS hour, count(*) AS n
         FROM messages WHERE direction='in' AND created_at > now() - ($1 || ' days')::interval GROUP BY 1,2`,
      [days, tz],
    )

    const ai = await one<any>(
      `SELECT (SELECT count(*) FROM messages WHERE sender_type='ai' AND direction='out' AND status<>'blocked' AND created_at > now() - ($1 || ' days')::interval) AS ai_replies,
              (SELECT count(*) FROM messages WHERE sender_type='flow' AND direction='out' AND created_at > now() - ($1 || ' days')::interval) AS flow_messages,
              (SELECT count(*) FROM messages WHERE sender_type='agent' AND direction='out' AND created_at > now() - ($1 || ' days')::interval) AS agent_messages,
              (SELECT round(avg(latency_ms)) FROM ai_usage WHERE task='agent' AND ok AND created_at > now() - ($1 || ' days')::interval) AS agent_latency_ms,
              (SELECT coalesce(sum(input_tokens),0) + coalesce(sum(output_tokens),0) FROM ai_usage WHERE created_at > now() - ($1 || ' days')::interval) AS tokens`,
      [days],
    )

    return { days: qs.days, totals, daily, reasons, sectors, agents, funnel, heat, ai }
  })
}

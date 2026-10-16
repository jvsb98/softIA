import { AlertCircle, ArrowRightLeft, Bot, Check, CheckCheck, Clock, FileText, RotateCw, ShieldAlert, Smartphone, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { cx } from '@/components/ui'
import { api } from '@/lib/api'
import { bytes, clock } from '@/lib/format'

const SENDER_LABEL: Record<string, string> = {
  ai: 'Assistente IA',
  flow: 'Fluxo',
  system: 'Sistema',
  phone: 'Pelo celular',
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'queued' || status === 'sending') return <Clock className="size-3" aria-label="enviando" />
  if (status === 'sent') return <Check className="size-3" aria-label="enviada" />
  if (status === 'delivered') return <CheckCheck className="size-3" aria-label="entregue" />
  if (status === 'read') return <CheckCheck className="size-3 text-nimbus" aria-label="lida" />
  if (status === 'failed') return <AlertCircle className="size-3 text-coral" aria-label="falhou" />
  if (status === 'blocked') return <ShieldAlert className="size-3 text-coral" aria-label="bloqueada pelo compliance" />
  return null
}

/** Texto com formatação do WhatsApp (*negrito*, _itálico_, ~riscado~) e links. */
export function WaText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 break-all">
            {p}
          </a>
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: formatWa(p) }} />
        ),
      )}
    </>
  )
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatWa(s: string) {
  return escapeHtml(s)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>')
}

function Media({ m, out }: { m: any; out: boolean }) {
  if (!m.media) {
    if (['image', 'audio', 'video', 'document', 'sticker'].includes(m.kind))
      return <div className="text-[12px] italic opacity-70">Mídia indisponível</div>
    return null
  }
  const url = `/api/media/${m.media.id}`
  if (m.kind === 'image' || m.kind === 'sticker')
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={m.body || 'Imagem recebida'} className={cx('max-h-72 rounded-[8px] object-cover', m.kind === 'sticker' ? 'max-w-[140px]' : 'max-w-[280px]')} loading="lazy" />
      </a>
    )
  if (m.kind === 'audio') return <audio controls src={url} className="h-10 w-[260px]" preload="none" />
  if (m.kind === 'video') return <video controls src={url} className="max-h-72 max-w-[300px] rounded-[8px]" preload="metadata" />
  return (
    <a
      href={`${url}?download=1`}
      className={cx('flex items-center gap-3 rounded-[8px] px-3 py-2', out ? 'bg-white/10' : 'bg-panel-2')}
    >
      <FileText className="size-5 shrink-0" />
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{m.media.filename || 'documento'}</span>
        <span className="text-[11px] opacity-70">{bytes(m.media.size)}</span>
      </span>
    </a>
  )
}

export function MessageItem({ m, onReply }: { m: any; onReply?: (m: any) => void }) {
  if (m.kind === 'note') {
    return (
      <div className="mx-auto my-1 w-full max-w-[560px] rounded-[10px] border border-warn/30 bg-[var(--bubble-note)] px-3 py-2 text-[13.5px] text-ink">
        <div className="mb-0.5 flex items-center justify-between text-[11.5px] text-warn">
          <span className="font-semibold">Nota interna · {m.sender_name}</span>
          <span>{clock(m.created_at)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words">{m.body}</div>
      </div>
    )
  }
  const out = m.direction === 'out'
  const automated = out && (m.sender_type === 'ai' || m.sender_type === 'flow' || m.sender_type === 'system')
  return (
    <div className={cx('group flex', out ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'relative max-w-[min(560px,78%)] rounded-[12px] px-3 py-2 text-[14px] shadow-[0_1px_1px_rgb(0_0_0/0.06)]',
          out
            ? automated
              ? 'rounded-br-[4px] border border-nimbus/40 bg-nimbus-soft text-ink'
              : 'rounded-br-[4px] bg-[var(--bubble-out)] text-[var(--bubble-out-ink)]'
            : 'rounded-bl-[4px] border border-line bg-[var(--bubble-in)] text-ink',
          m.status === 'blocked' && 'opacity-70 ring-1 ring-coral',
        )}
      >
        {out && (m.sender_type !== 'agent' || m.sender_name) && (
          <div className={cx('mb-0.5 flex items-center gap-1 text-[11.5px] font-semibold', automated ? 'text-nimbus-ink' : 'opacity-70')}>
            {m.sender_type === 'ai' && <Bot className="size-3" />}
            {m.sender_type === 'flow' && <Workflow className="size-3" />}
            {m.sender_type === 'phone' && <Smartphone className="size-3" />}
            {m.sender_type === 'agent' ? m.sender_name : SENDER_LABEL[m.sender_type] ?? m.sender_type}
          </div>
        )}
        {m.quoted && (
          <div className={cx('mb-1.5 rounded-[6px] border-l-[3px] px-2 py-1 text-[12.5px] opacity-80', out ? 'border-coral bg-black/10' : 'border-nimbus bg-panel-2')}>
            <span className="line-clamp-2">{m.quoted.body || `[${m.quoted.kind}]`}</span>
          </div>
        )}
        <Media m={m} out={out && !automated} />
        {m.body && m.kind !== 'audio' && (
          <div className={cx('whitespace-pre-wrap break-words leading-[1.45]', m.media && 'mt-1.5')}>
            <WaText text={m.body} />
          </div>
        )}
        {m.transcript && (
          <div className="mt-1.5 rounded-[6px] bg-black/5 px-2 py-1 text-[12.5px] italic dark:bg-white/5">
            <span className="not-italic font-semibold">Transcrição: </span>
            {m.transcript}
          </div>
        )}
        {m.meta?.reaction && <span className="absolute -bottom-3 right-2 rounded-full border border-line bg-panel px-1 text-[13px]">{m.meta.reaction}</span>}
        <div className={cx('mt-1 flex items-center justify-end gap-1 text-[11px]', out && !automated ? 'opacity-60' : 'text-muted')}>
          {m.status === 'blocked' && <span className="mr-1 font-medium text-coral-ink">bloqueada pelo compliance</span>}
          {clock(m.created_at)}
          {out && <StatusIcon status={m.status} />}
        </div>
        {m.status === 'failed' && (
          <button
            onClick={() => api.post(`/api/messages/${m.id}/retry`).catch((e) => toast.error(e.message))}
            className="mt-1 flex items-center gap-1 text-[12px] font-medium text-coral"
            title={m.error ?? ''}
          >
            <RotateCw className="size-3" /> Falhou ({m.error ?? 'erro'}). Reenviar
          </button>
        )}
        {onReply && m.wa_id && (
          <button
            onClick={() => onReply(m)}
            className={cx(
              'absolute top-1 hidden rounded-[6px] border border-line bg-panel px-1.5 py-0.5 text-[11px] text-ink-2 shadow group-hover:block',
              out ? '-left-16' : '-right-16',
            )}
          >
            Responder
          </button>
        )}
      </div>
    </div>
  )
}

const EVENT_TEXT: Record<string, (e: any) => string> = {
  'conversation.opened': (e) => (e.data?.reopened ? 'Cliente voltou — conversa reaberta na fila' : 'Conversa iniciada'),
  'conversation.assigned': (e) => `Atribuída a ${e.data?.user_name ?? 'atendente'}`,
  'conversation.transferred': (e) => `Transferida para ${e.data?.to_sector ?? 'outro setor'}${e.data?.reason ? ` — ${e.data.reason}` : ''}`,
  'conversation.closed': (e) => `Encerrada${e.actor_name ? ` por ${e.actor_name}` : ''}${e.data?.reason ? ` — ${e.data.reason}` : ''}`,
  'conversation.automation_resumed': () => 'Devolvida para a automação',
  'conversation.started_by_agent': (e) => `Conversa iniciada por ${e.actor_name ?? 'atendente'}`,
  'phone.reply': () => 'Resposta enviada pelo celular — automação pausada',
  'offhours.sent': (e) => `Fora do horário de ${e.data?.sector ?? 'atendimento'}: mensagem automática enviada`,
  'ai.handoff': (e) => `IA transferiu: ${e.data?.reason ?? ''}`,
  'compliance.blocked': (e) => `Compliance bloqueou uma resposta da IA (${e.data?.rule ?? 'regra'})`,
  'lead.qualified': (e) => `Lead qualificado — score ${e.data?.score}`,
  'lead.disqualified': (e) => `Lead desqualificado${e.data?.reason ? `: ${e.data.reason}` : ''}`,
  'flow.started': (e) => `Fluxo "${e.data?.flow ?? ''}" iniciado`,
  'flow.finished': (e) => `Fluxo "${e.data?.flow ?? ''}" concluído`,
  'followup.sent': (e) => `Follow-up automático ${e.data?.attempt ?? ''} enviado`,
}

export function EventItem({ e }: { e: any }) {
  const fn = EVENT_TEXT[e.type]
  if (!fn) return null
  return (
    <div className="my-1 flex justify-center">
      <span className="inline-flex items-center gap-1.5 rounded-[6px] bg-panel/80 px-2.5 py-1 text-[12px] text-muted backdrop-blur">
        {e.type.startsWith('ai.') || e.type.startsWith('compliance') ? <Bot className="size-3 text-nimbus-ink" /> : <ArrowRightLeft className="size-3" />}
        {fn(e)} · {clock(e.created_at)}
      </span>
    </div>
  )
}

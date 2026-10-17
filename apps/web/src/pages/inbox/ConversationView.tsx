import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Bot, CheckCircle2, Flag, Hand, Undo2 } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Avatar, Badge, Button, cx, Empty, PixelGlyph, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { contactName, CONV_STATUS, dayLabel, formatPhone } from '../../lib/format'
import { useSession } from '../../lib/session'
import { getSocket } from '../../lib/socket'
import { Composer } from './Composer'
import { CloseDialog, TransferDialog } from './dialogs'
import { EventItem, MessageItem } from './MessageItem'
import { viewExtras } from './view.extra'

export function ConversationView({ conversation }: { conversation: any }) {
  const { me } = useSession()
  const qc = useQueryClient()
  const id = conversation.id
  const scroller = useRef<HTMLDivElement>(null)
  const [replyTo, setReplyTo] = useState<any>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [peerTyping, setPeerTyping] = useState<string | null>(null)
  const [draftSeed, setDraftSeed] = useState<{ text: string; at: number } | null>(null)

  const messages = useQuery({
    queryKey: ['messages', id],
    queryFn: () => api.get<{ messages: any[]; events: any[] }>(`/api/conversations/${id}/messages?limit=120`),
  })

  // Entra na "sala" da conversa para receber eventos e marca como lida
  useEffect(() => {
    const s = getSocket()
    s.emit('conversation:watch', id)
    const onTyping = (p: any) => p.conversationId === id && setPeerTyping(p.typing ? p.name : null)
    s.on('agent:typing', onTyping)
    if (conversation.unread_count > 0 && conversation.assignee_id === me?.user.id) api.post(`/api/conversations/${id}/read`).catch(() => {})
    return () => {
      s.emit('conversation:unwatch', id)
      s.off('agent:typing', onTyping)
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Rola para o fim quando chegam mensagens (se o usuário já estava perto do fim)
  const count = messages.data?.messages.length ?? 0
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240
    if (nearBottom || count < 130) el.scrollTop = el.scrollHeight
  }, [count])

  useEffect(() => {
    if (conversation.unread_count > 0 && conversation.assignee_id === me?.user.id && !document.hidden) {
      const t = setTimeout(() => api.post(`/api/conversations/${id}/read`).catch(() => {}), 800)
      return () => clearTimeout(t)
    }
  }, [conversation.unread_count, conversation.assignee_id, id, me?.user.id])

  const timeline = useMemo(() => {
    const items = [
      ...(messages.data?.messages ?? []).map((m) => ({ t: 'm' as const, at: m.created_at, m })),
      ...(messages.data?.events ?? []).map((e) => ({ t: 'e' as const, at: e.created_at, e })),
    ].sort((a, b) => a.at.localeCompare(b.at))
    return items
  }, [messages.data])

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key)
    try {
      await fn()
      if (ok) toast.success(ok)
      qc.invalidateQueries({ queryKey: ['conversation', id] })
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  const mine = conversation.assignee_id === me?.user.id
  const closed = conversation.status === 'closed'
  const name = contactName(conversation.contact)

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-5 py-3">
        <Avatar name={name} color={conversation.sector?.color} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-ink">{name}</span>
            <Badge tone={conversation.status === 'automation' ? 'ai' : conversation.status === 'queued' ? 'warn' : conversation.status === 'closed' ? 'neutral' : 'ok'}>
              {conversation.status === 'automation' && <Bot className="size-3" />}
              {CONV_STATUS[conversation.status]}
            </Badge>
          </div>
          <div className="truncate text-[12.5px] text-muted">
            {formatPhone(conversation.contact?.phone)}
            {conversation.sector && <> · {conversation.sector.name}</>}
            {conversation.assignee && <> · com {conversation.assignee.name}</>}
            {conversation.connection && <> · via {conversation.connection.name}</>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!closed && !mine && (
            <Button variant="primary" size="sm" icon={<Hand className="size-4" />} loading={busy === 'assign'} onClick={() => act('assign', () => api.post(`/api/conversations/${id}/assign`, {}), 'Conversa assumida.')}>
              Assumir
            </Button>
          )}
          {!closed && (
            <Button size="sm" icon={<ArrowLeftRight className="size-4" />} onClick={() => setTransferOpen(true)}>
              Transferir
            </Button>
          )}
          {!closed && conversation.status !== 'automation' && (
            <Button size="sm" variant="ai" icon={<Undo2 className="size-4" />} loading={busy === 'auto'} onClick={() => act('auto', () => api.post(`/api/conversations/${id}/automation`), 'Devolvida para a automação.')} title="Devolver para a automação (fluxo/IA)">
              Automação
            </Button>
          )}
          {!closed && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Flag className={cx('size-4', conversation.priority > 0 && 'fill-coral text-coral')} />}
              onClick={() => act('prio', () => api.post(`/api/conversations/${id}/priority`, { priority: conversation.priority > 0 ? 0 : 2 }))}
              title="Marcar prioridade"
            />
          )}
          {!closed && (
            <Button size="sm" icon={<CheckCircle2 className="size-4" />} onClick={() => setCloseOpen(true)}>
              Encerrar
            </Button>
          )}
        </div>
      </header>

      {viewExtras.map((Extra, i) => (
        <Extra key={i} conversation={conversation} onUseDraft={(text: string) => setDraftSeed({ text, at: Date.now() })} />
      ))}

      {conversation.status === 'queued' && conversation.handoff_reason && !conversation.handoff_card && (
        <div className="border-b border-line bg-warn/10 px-5 py-2 text-[13px] text-ink-2">
          <span className="font-medium">Motivo da transferência:</span> {conversation.handoff_reason}
        </div>
      )}

      <div ref={scroller} className="chat-canvas min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {messages.isLoading ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Spinner />
          </div>
        ) : (
          <div className="mx-auto flex max-w-[900px] flex-col gap-2">
            {timeline.map((it, i) => {
              const prev = timeline[i - 1]
              const newDay = !prev || prev.at.slice(0, 10) !== it.at.slice(0, 10)
              return (
                <Fragment key={it.t === 'm' ? it.m.id : `e${it.e.id}`}>
                  {newDay && (
                    <div className="my-2 flex justify-center">
                      <span className="rounded-[6px] bg-panel px-2.5 py-0.5 text-[11.5px] font-medium capitalize text-muted shadow-sm">{dayLabel(it.at)}</span>
                    </div>
                  )}
                  {it.t === 'm' ? <MessageItem m={it.m} onReply={closed ? undefined : setReplyTo} /> : <EventItem e={it.e} />}
                </Fragment>
              )
            })}
            {peerTyping && (
              <div className="text-center text-[12px] text-muted">
                {peerTyping} está digitando
                <span className="na-typing ml-1">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {closed ? (
        <div className="flex items-center justify-between gap-4 border-t border-line bg-panel px-5 py-4 text-[13px] text-muted">
          <span>Conversa encerrada{conversation.close_reason ? ` — ${conversation.close_reason}` : ''}. Se o cliente escrever de novo, uma nova conversa é aberta.</span>
        </div>
      ) : (
        <Composer conversation={conversation} replyTo={replyTo} onClearReply={() => setReplyTo(null)} draftSeed={draftSeed} />
      )}

      <TransferDialog open={transferOpen} onClose={() => setTransferOpen(false)} conversation={conversation} />
      <CloseDialog open={closeOpen} onClose={() => setCloseOpen(false)} conversation={conversation} />
    </div>
  )
}

export function NoConversation() {
  return (
    <div className="chat-canvas flex h-full flex-1 items-center justify-center">
      <Empty title="Selecione uma conversa" glyph={<PixelGlyph pattern="chat" size={48} className="text-line-strong" />}>
        Escolha uma conversa na lista. Atalho: <span className="font-medium text-ink-2">Alt + ↑/↓</span> navega entre conversas.
      </Empty>
    </div>
  )
}

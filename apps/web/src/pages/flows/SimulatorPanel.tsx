import { FastForward, RotateCcw, Send, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cx, IconButton } from '../../components/ui'
import { api } from '../../lib/api'
import { WaText } from '../inbox/MessageItem'

export interface SimView {
  sessionId: string
  status: string
  currentNodeId: string | null
  vars: Record<string, any>
  contact: any
  transcript: { from: 'contact' | 'bot' | 'event'; text: string; at: string }[]
  visited: string[]
  pendingTimer: boolean
}

const STATUS: Record<string, string> = {
  idle: 'aguardando a primeira mensagem',
  waiting: 'esperando o contato',
  done: 'fluxo concluído',
  transferred: 'transferida',
  closed: 'encerrada',
  failed: 'erro',
}

export function SimulatorPanel({ flowId, getDraft, onView, onClose }: { flowId: string; getDraft: () => any; onView: (v: SimView | null) => void; onClose: () => void }) {
  const [view, setView] = useState<SimView | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'chat' | 'vars'>('chat')
  const scroller = useRef<HTMLDivElement>(null)

  const call = async (body: any) => {
    setBusy(true)
    try {
      const v = await api.post<SimView>(`/api/flows/${flowId}/simulate`, { ...body, draft: getDraft(), sessionId: view?.sessionId })
      setView(v)
      onView(v)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void call({ type: 'start' })
    return () => onView(null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scroller.current?.scrollTo({ top: 1e9, behavior: 'smooth' })
  }, [view?.transcript.length])

  const send = () => {
    if (!text.trim()) return
    const t = text
    setText('')
    void call({ type: 'message', text: t })
  }

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink">Simulador</div>
          <div className="text-[12px] text-muted">Teste o rascunho como se fosse o contato. Nada é enviado ao WhatsApp.</div>
        </div>
        <IconButton label="Reiniciar" onClick={() => void call({ type: 'start', sessionId: undefined })}>
          <RotateCcw className="size-4" />
        </IconButton>
        <IconButton label="Fechar simulador" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="flex gap-1 border-b border-line px-4 py-2 text-[12.5px]">
        {(['chat', 'vars'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx('rounded-[6px] px-2 py-1', tab === t ? 'bg-panel-2 font-medium text-ink' : 'text-muted')}>
            {t === 'chat' ? 'Conversa' : 'Variáveis e score'}
          </button>
        ))}
        {view && <Badge className="ml-auto self-center">{STATUS[view.status] ?? view.status}</Badge>}
      </div>
      {tab === 'chat' ? (
        <div ref={scroller} className="chat-canvas min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {view?.transcript.map((e, i) =>
            e.from === 'event' ? (
              <div key={i} className="text-center text-[11.5px] text-muted">
                <span className="rounded-[6px] bg-panel/90 px-2 py-0.5">{e.text}</span>
              </div>
            ) : (
              <div key={i} className={cx('flex', e.from === 'contact' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cx(
                    'max-w-[85%] whitespace-pre-wrap rounded-[12px] px-3 py-2 text-[13.5px]',
                    e.from === 'contact' ? 'rounded-br-[4px] bg-[var(--bubble-out)] text-[var(--bubble-out-ink)]' : 'rounded-bl-[4px] border border-nimbus/40 bg-nimbus-soft text-ink',
                  )}
                >
                  <WaText text={e.text} />
                </div>
              </div>
            ),
          )}
          {busy && <div className="text-[12px] text-muted">processando…</div>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-[12.5px]">
          <div>
            <div className="mb-1 font-medium text-ink">Variáveis do fluxo</div>
            <pre className="whitespace-pre-wrap rounded-[8px] bg-panel-2 p-2 font-mono text-[11.5px] text-ink-2">{JSON.stringify(view?.vars ?? {}, null, 2)}</pre>
          </div>
          <div>
            <div className="mb-1 font-medium text-ink">Contato (simulado)</div>
            <div className="space-y-1 text-ink-2">
              <div>Status: {view?.contact?.lead_status}</div>
              <div>Score: {view?.contact?.score ?? '—'}</div>
              {(view?.contact?.score_breakdown ?? []).map((b: any) => (
                <div key={b.key}>
                  · {b.label}: {b.display} (+{b.points})
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="border-t border-line p-3">
        {view?.pendingTimer && (
          <Button size="sm" className="mb-2 w-full" icon={<FastForward className="size-4" />} onClick={() => void call({ type: 'timer' })}>
            Avançar tempo (disparar temporizador)
          </Button>
        )}
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Escreva como o contato…"
            className="h-10 flex-1 rounded-[10px] border border-line-strong bg-bg px-3 text-[13.5px] text-ink outline-none focus:border-ink/30"
          />
          <button onClick={send} disabled={busy || !text.trim()} className="flex size-10 items-center justify-center rounded-[10px] bg-coral text-white disabled:opacity-40" aria-label="Enviar">
            <Send className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}

import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, RefreshCw, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, cx, PixelGlyph } from '@/components/ui'
import { api } from '@/lib/api'
import { LEAD_STATUS } from '@/lib/format'

/** Cartão de contexto gerado pela IA na transferência + botão "Sugerir resposta". */
export function AiAssistBar({ conversation, onUseDraft }: { conversation: any; onUseDraft: (text: string) => void }) {
  const card = conversation.handoff_card
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState<'suggest' | 'card' | null>(null)
  const qc = useQueryClient()
  if (conversation.status === 'closed' || conversation.status === 'automation') return null

  const suggest = async () => {
    setBusy('suggest')
    try {
      const r = await api.post<{ text: string; blocked?: string }>(`/api/conversations/${conversation.id}/suggest`)
      if (r.blocked) toast.warning(`A sugestão foi descartada pelo compliance (${r.blocked}). Escreva a resposta manualmente.`)
      else if (r.text) onUseDraft(r.text)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }
  const regen = async () => {
    setBusy('card')
    try {
      await api.post(`/api/conversations/${conversation.id}/handoff-card`)
      await qc.invalidateQueries({ queryKey: ['conversation', conversation.id] })
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-b border-nimbus/40 bg-nimbus-soft">
      <div className="flex items-center gap-3 px-5 py-2">
        <PixelGlyph pattern="ai" size={16} className="text-nimbus-ink" />
        <div className="min-w-0 flex-1 text-[13px] text-ink">
          {card ? (
            <>
              <span className="font-semibold">Contexto da IA</span>
              <span className="text-ink-2"> · {card.reason ?? conversation.handoff_reason}</span>
            </>
          ) : (
            <span className="text-ink-2">{conversation.handoff_reason ? `Motivo da transferência: ${conversation.handoff_reason}` : 'Assistente IA disponível para sugerir respostas.'}</span>
          )}
        </div>
        <Button size="sm" variant="ai" icon={<Sparkles className="size-3.5" />} loading={busy === 'suggest'} onClick={suggest}>
          Sugerir resposta
        </Button>
        {card ? (
          <button onClick={() => setOpen(!open)} className="text-nimbus-ink" aria-label={open ? 'Recolher contexto' : 'Mostrar contexto'}>
            {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
        ) : (
          conversation.handoff_reason && (
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy === 'card'} onClick={regen}>
              Gerar resumo
            </Button>
          )
        )}
      </div>
      {card && open && (
        <div className="grid gap-4 px-5 pb-4 md:grid-cols-[1fr_260px]">
          <div className="space-y-2 text-[13.5px] leading-relaxed text-ink">
            {card.summary ? <p>{card.summary}</p> : <p className="text-ink-2">Resumo indisponível (IA sem resposta). Veja o histórico abaixo.</p>}
            {card.interest && (
              <p className="text-ink-2">
                <span className="font-medium text-ink">Interesse:</span> {card.interest}
              </p>
            )}
            {card.attention?.length > 0 && (
              <ul className="list-inside list-disc text-ink-2">
                {card.attention.map((a: string, i: number) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
            {card.suggestedReply && (
              <div className="mt-2 rounded-[10px] border border-nimbus/40 bg-panel p-3">
                <div className="mb-1 text-[11.5px] font-medium text-nimbus-ink">Primeira mensagem sugerida</div>
                <p className="text-[13.5px] text-ink">{card.suggestedReply}</p>
                <Button size="sm" className="mt-2" onClick={() => onUseDraft(card.suggestedReply)}>
                  Usar no rascunho
                </Button>
              </div>
            )}
          </div>
          <ScoreCard score={card.score} breakdown={card.breakdown} status={card.leadStatus} />
        </div>
      )}
    </div>
  )
}

export function ScoreCard({ score, breakdown, status }: { score: number | null; breakdown: any[]; status?: string }) {
  if (score == null && !breakdown?.length) return null
  const max = Math.max(1, ...((breakdown ?? []).map((b) => b.points) as number[]))
  return (
    <div className="rounded-[10px] border border-line bg-panel p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-muted">Score de qualificação</span>
        {status && <span className="text-[11.5px] text-nimbus-ink">{LEAD_STATUS[status] ?? status}</span>}
      </div>
      <div className="font-display text-[30px] leading-none text-ink">{score ?? '—'}</div>
      <ul className="mt-3 space-y-2">
        {(breakdown ?? []).map((b) => (
          <li key={b.key} className="text-[12.5px]">
            <div className="flex justify-between gap-2">
              <span className="truncate text-ink-2">{b.label}</span>
              <span className="shrink-0 font-semibold text-ink">+{b.points}</span>
            </div>
            <div className="truncate text-[11.5px] text-muted">{b.display}</div>
            <div className="mt-1 h-1 rounded bg-panel-2">
              <div className="h-1 rounded bg-nimbus" style={{ width: `${(b.points / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Bloco no painel lateral: score atual do contato. */
export function ScoreContextBlock({ contact }: { conversation: any; contact: any }) {
  if (!contact || (contact.score == null && !(contact.score_breakdown ?? []).length)) return null
  return (
    <div className={cx('border-b border-line px-5 py-4')}>
      <ScoreCard score={contact.score} breakdown={contact.score_breakdown ?? []} />
    </div>
  )
}

import { Paperclip, Send, StickyNote, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { cx, IconButton, Kbd } from '@/components/ui'
import { api } from '@/lib/api'
import { contactName } from '@/lib/format'
import { useQuickReplies } from '@/lib/queries'
import { getSocket } from '@/lib/socket'

export function Composer({
  conversation,
  replyTo,
  onClearReply,
  disabled,
  draftSeed,
}: {
  conversation: any
  replyTo: any | null
  onClearReply: () => void
  disabled?: boolean
  draftSeed?: { text: string; at: number } | null
}) {
  const key = `na:draft:${conversation.id}`
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? ''
    } catch {
      return ''
    }
  })
  const [note, setNote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [qrIndex, setQrIndex] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const quick = useQuickReplies()
  const typingTimer = useRef<any>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem(key, text)
    } catch {
      /* ignora */
    }
  }, [key, text])

  // Sugestão da IA (ou outro componente) pode semear o rascunho
  useEffect(() => {
    if (draftSeed?.text) {
      setText(draftSeed.text)
      setNote(false)
      setTimeout(() => ta.current?.focus(), 10)
    }
  }, [draftSeed])

  useEffect(() => {
    ta.current?.focus()
  }, [conversation.id])

  // Auto altura
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [text])

  const slash = text.startsWith('/') && !text.includes('\n') ? text.slice(1).toLowerCase() : null
  const matches = useMemo(() => {
    if (slash === null) return []
    return (quick.data ?? []).filter((q) => q.shortcut.toLowerCase().includes(slash) || q.title.toLowerCase().includes(slash)).slice(0, 8)
  }, [slash, quick.data])

  const fillVars = (body: string) =>
    body
      .replace(/\{\{\s*nome\s*\}\}/gi, contactName(conversation.contact).split(' ')[0] ?? '')
      .replace(/\{\{\s*setor\s*\}\}/gi, conversation.sector?.name ?? '')

  const pickQuick = (q: any) => {
    setText(fillVars(q.body))
    setQrIndex(0)
    ta.current?.focus()
  }

  const emitTyping = () => {
    if (note) return
    getSocket().emit('typing', { conversationId: conversation.id, typing: true })
    if (!typingTimer.current) api.post(`/api/conversations/${conversation.id}/typing`, { typing: true }).catch(() => {})
    clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null
      api.post(`/api/conversations/${conversation.id}/typing`, { typing: false }).catch(() => {})
    }, 3000)
  }

  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      if (note) await api.post(`/api/conversations/${conversation.id}/notes`, { text: body })
      else await api.post(`/api/conversations/${conversation.id}/send`, { text: body, quotedMessageId: replyTo?.id ?? null })
      setText('')
      onClearReply()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setBusy(false)
      ta.current?.focus()
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setQrIndex((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setQrIndex((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickQuick(matches[qrIndex] ?? matches[0])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const upload = async (f: File) => {
    const form = new FormData()
    form.append('caption', text.trim())
    form.append('file', f)
    setBusy(true)
    try {
      await api.upload(`/api/conversations/${conversation.id}/media`, form)
      setText('')
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cx('relative border-t border-line px-4 pb-4 pt-3', note ? 'bg-[var(--bubble-note)]' : 'bg-panel')}>
      {matches.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-2 overflow-hidden rounded-[10px] border border-line bg-panel shadow-panel">
          <div className="border-b border-line px-3 py-1.5 text-[11.5px] text-muted">Respostas rápidas</div>
          {matches.map((q, i) => (
            <button
              key={q.id}
              onMouseDown={(e) => {
                e.preventDefault()
                pickQuick(q)
              }}
              className={cx('block w-full px-3 py-2 text-left', i === qrIndex ? 'bg-panel-2' : 'hover:bg-panel-2')}
            >
              <span className="text-[13px] font-medium text-ink">/{q.shortcut}</span> <span className="text-[13px] text-muted">{q.title}</span>
              <span className="mt-0.5 line-clamp-1 block text-[12px] text-muted">{q.body}</span>
            </button>
          ))}
        </div>
      )}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-[8px] border-l-[3px] border-coral bg-panel-2 px-3 py-1.5 text-[12.5px] text-ink-2">
          <span className="line-clamp-1 flex-1">Respondendo: {replyTo.body || `[${replyTo.kind}]`}</span>
          <IconButton label="Cancelar resposta" onClick={onClearReply} className="size-6">
            <X className="size-3.5" />
          </IconButton>
        </div>
      )}
      <div className={cx('flex items-end gap-2 rounded-[12px] border bg-bg px-2 py-1.5 focus-within:border-ink/30', note ? 'border-warn/50' : 'border-line-strong')}>
        <IconButton label="Anexar arquivo" onClick={() => file.current?.click()} disabled={disabled || busy || note}>
          <Paperclip className="size-[18px]" />
        </IconButton>
        <input ref={file} type="file" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            setQrIndex(0)
            emitTyping()
          }}
          onKeyDown={onKey}
          onPaste={(e) => {
            const f = e.clipboardData.files?.[0]
            if (f && !note) {
              e.preventDefault()
              void upload(f)
            }
          }}
          placeholder={disabled ? 'Conversa encerrada' : note ? 'Nota interna — só a equipe vê. Use @nome para mencionar.' : 'Escreva uma mensagem. Digite / para respostas rápidas.'}
          className="max-h-[220px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[14px] text-ink outline-none placeholder:text-muted focus-visible:outline-none"
        />
        <IconButton label={note ? 'Voltar para mensagem' : 'Nota interna'} active={note} onClick={() => setNote(!note)} disabled={disabled}>
          <StickyNote className="size-[18px]" />
        </IconButton>
        <button
          onClick={() => void send()}
          disabled={!text.trim() || busy || disabled}
          className={cx('flex size-9 items-center justify-center rounded-[9px] text-white transition disabled:opacity-40', note ? 'bg-warn' : 'bg-coral')}
          aria-label={note ? 'Salvar nota' : 'Enviar'}
        >
          <Send className="size-4" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-3 px-1 text-[11.5px] text-muted">
        <span>
          <Kbd>Enter</Kbd> envia · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> quebra linha
        </span>
        <span className="inline-flex items-center gap-1">
          <Zap className="size-3" /> <Kbd>/</Kbd> respostas rápidas
        </span>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Spinner } from '@/components/ui'
import { ContextPanel, useConversation } from './ContextPanel'
import { ConversationList } from './ConversationList'
import { ConversationView, NoConversation } from './ConversationView'
import { StartConversationDialog } from './dialogs'
import { useQueryClient } from '@tanstack/react-query'

export function InboxPage() {
  const { conversationId } = useParams()
  const conv = useConversation(conversationId)
  const [startOpen, setStartOpen] = useState(false)
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Alt+↑/↓ navega entre as conversas da lista visível
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
      const lists = qc.getQueriesData<any[]>({ queryKey: ['conversations'] }).map(([, d]) => d).filter(Array.isArray)
      const list = lists.find((l) => l.some((c) => c.id === conversationId)) ?? lists[0]
      if (!list?.length) return
      const idx = list.findIndex((c) => c.id === conversationId)
      const next = list[e.key === 'ArrowDown' ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0)]
      if (next) navigate(`/atendimento/${next.id}`)
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [conversationId, navigate, qc])

  return (
    <div className="flex h-full">
      <ConversationList onNew={() => setStartOpen(true)} />
      {!conversationId ? (
        <NoConversation />
      ) : conv.isLoading ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Spinner />
        </div>
      ) : conv.error ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">{(conv.error as Error).message}</div>
      ) : conv.data ? (
        <>
          <ConversationView key={conv.data.id} conversation={conv.data} />
          <ContextPanel conversation={conv.data} />
        </>
      ) : null}
      <StartConversationDialog open={startOpen} onClose={() => setStartOpen(false)} />
    </div>
  )
}

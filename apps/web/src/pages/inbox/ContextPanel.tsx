import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Pencil, UserX } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cx, IconButton, Input, Select, TagChip, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { contactName, CONV_STATUS, dateTime, formatPhone, LEAD_STATUS } from '../../lib/format'
import { useTags } from '../../lib/queries'
import { useSession } from '../../lib/session'
import { contextExtras } from './context.extra'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 py-1.5 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-ink">{children}</span>
    </div>
  )
}

export function ContextPanel({ conversation }: { conversation: any }) {
  const { me } = useSession()
  const qc = useQueryClient()
  const contact = conversation.contactFull ?? conversation.contact
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', notes: '' })
  useEffect(() => {
    setForm({ name: contact?.name ?? '', email: contact?.email ?? '', notes: contact?.notes ?? '' })
    setEditing(false)
  }, [contact?.id, contact?.name, contact?.email, contact?.notes])

  const save = useMutation({
    mutationFn: (body: any) => api.patch(`/api/contacts/${contact.id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', conversation.id] })
      setEditing(false)
    },
    onError: (e: any) => toast.error(e.message),
  })

  return (
    <aside className="hidden w-[320px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel xl:flex">
      <div className="border-b border-line px-5 py-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-display text-[22px] leading-tight text-ink">{contactName(contact)}</div>
            {contact?.push_name && contact.name && contact.push_name !== contact.name && <div className="text-[12px] text-muted">no WhatsApp: {contact.push_name}</div>}
          </div>
          <IconButton label="Editar contato" onClick={() => setEditing(!editing)} active={editing}>
            <Pencil className="size-4" />
          </IconButton>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge tone={conversation.status === 'automation' ? 'ai' : conversation.status === 'queued' ? 'warn' : 'neutral'}>{CONV_STATUS[conversation.status]}</Badge>
          {contact?.is_customer && <Badge tone="ok">Cliente</Badge>}
          {contact?.opted_out && <Badge tone="coral">Não quer receber mensagens</Badge>}
        </div>
      </div>

      {editing ? (
        <div className="space-y-3 border-b border-line px-5 py-4">
          <Input placeholder="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input placeholder="E-mail" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Textarea placeholder="Observações sobre o contato" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ name: form.name || null, email: form.email || '', notes: form.notes || null })}>
              Salvar
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-b border-line px-5 py-3">
          <Row label="WhatsApp">{formatPhone(contact?.phone) || 'número oculto (LID)'}</Row>
          <Row label="E-mail">{contact?.email || <span className="text-muted">—</span>}</Row>
          <Row label="Número">{conversation.connection?.name}</Row>
          <Row label="Origem">{contact?.origin || <span className="text-muted">—</span>}</Row>
          {contact?.notes && <Row label="Notas">{contact.notes}</Row>}
        </div>
      )}

      <div className="border-b border-line px-5 py-4">
        <div className="mb-2 text-[12px] font-medium text-muted">Status do lead</div>
        <Select
          value={contact?.lead_status ?? 'novo'}
          onChange={(e) => save.mutate({ leadStatus: e.target.value })}
          className="h-9 text-[13px]"
          aria-label="Status do lead"
        >
          {Object.entries(LEAD_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={!!contact?.is_customer} onChange={(e) => save.mutate({ isCustomer: e.target.checked })} className="accent-[var(--coral)]" />
          Já é investidor (cliente)
        </label>
      </div>

      {contextExtras.map((Extra, i) => (
        <Extra key={i} conversation={conversation} contact={contact} />
      ))}

      <TagsBlock contactId={contact?.id} current={conversation.contact?.tags ?? []} conversationId={conversation.id} />

      <div className="px-5 py-4">
        <div className="mb-2 text-[12px] font-medium text-muted">Conversas anteriores</div>
        {conversation.history?.length ? (
          <ul className="space-y-1.5">
            {conversation.history.map((h: any) => (
              <li key={h.id} className="flex items-center justify-between text-[12.5px]">
                <a href={`/atendimento/${h.id}`} className="text-ink-2 hover:text-ink hover:underline">
                  {dateTime(h.created_at)}
                </a>
                <span className="text-muted">{h.sector ?? CONV_STATUS[h.status]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-muted">Primeiro contato.</p>
        )}
        {me?.user.role !== 'agent' && contact?.id && (
          <div className="mt-4 flex flex-col items-start gap-1.5">
            <a href={`/api/contacts/${contact.id}/export`} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink">
              <Download className="size-3.5" /> Exportar dados do titular (LGPD)
            </a>
            {me?.user.role === 'admin' && (
              <button
                className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-coral-ink"
                onClick={async () => {
                  if (!confirm('Anonimizar este contato? Nome, telefone, e-mail, perfil e o texto das mensagens serão apagados de forma definitiva. Use quando o titular pedir a eliminação dos dados.')) return
                  try {
                    await api.post(`/api/contacts/${contact.id}/anonymize`)
                    toast.success('Contato anonimizado.')
                    qc.invalidateQueries()
                  } catch (e: any) {
                    toast.error(e.message)
                  }
                }}
              >
                <UserX className="size-3.5" /> Anonimizar titular (LGPD)
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

function TagsBlock({ contactId, current, conversationId }: { contactId: string; current: any[]; conversationId: string }) {
  const tags = useTags()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [newTag, setNewTag] = useState('')
  const ids = new Set(current.map((t) => t.id))
  const toggle = async (id: string) => {
    const next = ids.has(id) ? [...ids].filter((x) => x !== id) : [...ids, id]
    await api.put(`/api/contacts/${contactId}/tags`, { tagIds: next })
    qc.invalidateQueries({ queryKey: ['conversation', conversationId] })
  }
  const create = async () => {
    if (!newTag.trim()) return
    const t = await api.post('/api/tags', { name: newTag.trim(), color: ['#FE5A51', '#99C1E4', '#7FB685', '#C9A227', '#9B8AFB'][Math.floor(Math.random() * 5)] })
    setNewTag('')
    await qc.invalidateQueries({ queryKey: ['tags'] })
    await toggle(t.id)
  }
  return (
    <div className="border-b border-line px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-medium text-muted">Etiquetas</span>
        <button className="text-[12px] text-ink-2 hover:text-ink" onClick={() => setOpen(!open)}>
          {open ? 'Fechar' : 'Editar'}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {current.length ? current.map((t) => <TagChip key={t.id} name={t.name} color={t.color} />) : <span className="text-[12.5px] text-muted">Sem etiquetas</span>}
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {(tags.data ?? []).map((t) => (
              <button
                key={t.id}
                onClick={() => void toggle(t.id)}
                className={cx('rounded-[5px] border px-1.5 py-0.5 text-[12px]', ids.has(t.id) ? 'border-ink bg-ink text-bg' : 'border-line text-ink-2 hover:border-line-strong')}
              >
                {t.name}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="Nova etiqueta" className="h-8 text-[13px]" onKeyDown={(e) => e.key === 'Enter' && void create()} />
            <Button size="sm" onClick={() => void create()}>
              Criar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function useConversation(id?: string) {
  return useQuery({ queryKey: ['conversation', id], queryFn: () => api.get<any>(`/api/conversations/${id}`), enabled: !!id })
}

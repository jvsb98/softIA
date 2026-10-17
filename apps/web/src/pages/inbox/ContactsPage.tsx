import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Avatar, Badge, Empty, PageHeader, Select, Table, TagChip } from '../../components/ui'
import { api, qs } from '../../lib/api'
import { ago, contactName, formatPhone, LEAD_STATUS } from '../../lib/format'

export function ContactsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const list = useQuery({ queryKey: ['contacts', search, status], queryFn: () => api.get<any[]>(`/api/contacts${qs({ search, status, limit: 200 })}`) })
  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <PageHeader title="Contatos" description="Todas as pessoas que falaram com a Nimber pelo WhatsApp, com status de lead e etiquetas." />
      <div className="mb-4 flex gap-3">
        <div className="relative w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nome, e-mail ou número"
            className="h-10 w-full rounded-[8px] border border-line-strong bg-panel pl-9 pr-3 text-sm outline-none focus:border-ink/40"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-52">
          <option value="">Todos os status</option>
          {Object.entries(LEAD_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      <div className="rounded-[12px] border border-line bg-panel">
        {!list.data?.length ? (
          <Empty title={list.isLoading ? 'Carregando…' : 'Nenhum contato encontrado'} />
        ) : (
          <Table head={['Contato', 'WhatsApp', 'Status', 'Score', 'Etiquetas', 'Conversas', 'Último contato']}>
            {list.data.map((c) => (
              <tr key={c.id} className="hover:bg-panel-2/50">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={contactName(c)} size={30} />
                    <div>
                      <div className="font-medium text-ink">{contactName(c)}</div>
                      {c.email && <div className="text-[12px] text-muted">{c.email}</div>}
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-ink-2">{formatPhone(c.phone)}</td>
                <td className="px-3 py-2.5">
                  <Badge tone={c.lead_status === 'qualificado' ? 'coral' : c.lead_status === 'cliente' ? 'ok' : 'neutral'}>{LEAD_STATUS[c.lead_status]}</Badge>
                </td>
                <td className="px-3 py-2.5 text-ink-2">{c.score ?? '—'}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {c.tags.map((t: any) => (
                      <TagChip key={t.id} name={t.name} color={t.color} />
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-ink-2">{c.conversations}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-muted">
                  <ContactLastLink contactId={c.id} label={ago(c.last_interaction_at)} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </div>
  )
}

function ContactLastLink({ contactId, label }: { contactId: string; label: string }) {
  const [go, setGo] = useState(false)
  const q = useQuery({ queryKey: ['contact', contactId], queryFn: () => api.get<any>(`/api/contacts/${contactId}`), enabled: go })
  const last = q.data?.conversations?.[0]
  if (last) return <Link className="hover:text-ink hover:underline" to={`/atendimento/${last.id}`}>{label}</Link>
  return (
    <button className="hover:text-ink hover:underline" onClick={() => setGo(true)}>
      {label}
    </button>
  )
}

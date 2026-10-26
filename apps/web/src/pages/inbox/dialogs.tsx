import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Dialog, Field, Input, Select, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { useConnections, useSectors, useUsers } from '../../lib/queries'
import { useSession } from '../../lib/session'

export function TransferDialog({ open, onClose, conversation }: { open: boolean; onClose: () => void; conversation: any }) {
  const sectors = useSectors()
  const users = useUsers()
  const [sectorId, setSectorId] = useState('')
  const [userId, setUserId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const allowed: string[] = conversation.connection?.allowed_sector_ids ?? []
  const options = (sectors.data ?? []).filter((s) => s.active && (!allowed.length || allowed.includes(s.id)))
  const people = (users.data ?? []).filter((u) => u.active && (!sectorId || u.sector_ids.includes(sectorId)))
  const submit = async () => {
    setBusy(true)
    try {
      await api.post(`/api/conversations/${conversation.id}/transfer`, { sectorId: sectorId || null, userId: userId || null, note: note || undefined })
      toast.success('Conversa transferida.')
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Transferir conversa"
      description="Escolha o setor. Se quiser, indique a pessoa — sem indicação, a regra de distribuição do setor decide."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!sectorId && !userId}>
            Transferir
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Setor">
          <Select value={sectorId} onChange={(e) => (setSectorId(e.target.value), setUserId(''))}>
            <option value="">Selecione…</option>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.queued ? ` · ${s.queued} na fila` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Atendente (opcional)">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Distribuição automática</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.presence === 'online' ? 'online' : u.presence === 'away' ? 'ausente' : 'offline'} · {u.open_conversations} abertas
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Contexto para o colega (nota interna)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: cliente quer orçamento de bancada em granito, 2,40 m." />
        </Field>
      </div>
    </Dialog>
  )
}

export function CloseDialog({ open, onClose, conversation }: { open: boolean; onClose: () => void; conversation: any }) {
  const [reason, setReason] = useState('Atendimento concluído')
  const [farewell, setFarewell] = useState('')
  const [busy, setBusy] = useState(false)
  const reasons = ['Atendimento concluído', 'Lead qualificado — reunião agendada', 'Sem interesse', 'Sem resposta do cliente', 'Dúvida resolvida', 'Encaminhado por outro canal', 'Spam / engano']
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Encerrar conversa"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.post(`/api/conversations/${conversation.id}/close`, { reason, farewell: farewell.trim() || undefined })
                toast.success('Conversa encerrada.')
                onClose()
              } catch (e: any) {
                toast.error(e.message)
              } finally {
                setBusy(false)
              }
            }}
          >
            Encerrar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Motivo">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Field label="Mensagem de despedida (opcional)" hint="Enviada ao cliente antes de encerrar.">
          <Textarea value={farewell} onChange={(e) => setFarewell(e.target.value)} placeholder="Obrigado pelo contato! Qualquer dúvida, é só chamar por aqui." />
        </Field>
      </div>
    </Dialog>
  )
}

export function StartConversationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useSession()
  const conns = useConnections()
  const sectors = useSectors()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const connected = (conns.data ?? []).filter((c) => c.status === 'connected')
  const [form, setForm] = useState({ connectionId: '', phone: '', name: '', text: '', sectorId: '' })
  const [busy, setBusy] = useState(false)
  const mySectors = (sectors.data ?? []).filter((s) => s.active && (me?.user.role !== 'agent' || me.user.sectorIds.includes(s.id)))
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nova conversa"
      description="Envio individual para um contato. Para evitar bloqueio do número, não use para disparos em massa."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!form.phone || !form.text || !(form.connectionId || connected[0])}
            onClick={async () => {
              setBusy(true)
              try {
                const c = await api.post('/api/conversations/start', {
                  ...form,
                  connectionId: form.connectionId || connected[0]?.id,
                  sectorId: form.sectorId || undefined,
                  name: form.name || undefined,
                })
                qc.invalidateQueries({ queryKey: ['conversations'] })
                onClose()
                navigate(`/atendimento/${c.id}`)
              } catch (e: any) {
                toast.error(e.message)
              } finally {
                setBusy(false)
              }
            }}
          >
            Enviar e abrir
          </Button>
        </>
      }
    >
      {connected.length === 0 ? (
        <p className="text-sm text-muted">Nenhum número conectado no momento. Conecte um número em Configurações → Conexões.</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Número de saída">
              <Select value={form.connectionId || connected[0]?.id} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}>
                {connected.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Setor">
              <Select value={form.sectorId} onChange={(e) => setForm({ ...form, sectorId: e.target.value })}>
                <option value="">Meu setor</option>
                {mySectors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="WhatsApp do contato" hint="Com DDD. Ex.: 41 99999-8888">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" />
            </Field>
            <Field label="Nome (opcional)">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
          </div>
          <Field label="Mensagem">
            <Textarea value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          </Field>
        </div>
      )}
    </Dialog>
  )
}

import { useQueryClient } from '@tanstack/react-query'
import { Plus, QrCode, Smartphone, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cx, Dialog, Empty, Field, Input, PageHeader, Select, Spinner, Switch } from '../../components/ui'
import { api } from '../../lib/api'
import { ago, formatPhone } from '../../lib/format'
import { useConnections, useSectors } from '../../lib/queries'
import { getSocket } from '../../lib/socket'
import { connectionExtraFields } from './connection.extra'

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'coral' | 'neutral' }> = {
  connected: { label: 'Conectado', tone: 'ok' },
  connecting: { label: 'Conectando…', tone: 'warn' },
  qr: { label: 'Aguardando leitura do QR Code', tone: 'warn' },
  disconnected: { label: 'Desconectado', tone: 'neutral' },
  logged_out: { label: 'Aparelho desconectado', tone: 'coral' },
  error: { label: 'Erro', tone: 'coral' },
}

export function ConnectionsSettings() {
  const conns = useConnections()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<any | null>(null)
  const [pairing, setPairing] = useState<string | null>(null)
  const [live, setLive] = useState<Record<string, any>>({})

  useEffect(() => {
    const s = getSocket()
    const on = (p: any) => {
      setLive((l) => ({ ...l, [p.id]: p }))
      if (p.status === 'connected') {
        qc.invalidateQueries({ queryKey: ['connections'] })
        setPairing((cur) => {
          if (cur === p.id) toast.success('WhatsApp conectado!')
          return cur === p.id ? null : cur
        })
      }
    }
    s.on('connection:status', on)
    return () => {
      s.off('connection:status', on)
    }
  }, [qc])

  const pairingConn = (conns.data ?? []).find((c) => c.id === pairing)
  const pairingLive = pairing ? { ...pairingConn, ...live[pairing] } : null

  return (
    <div>
      <PageHeader
        title="Conexões WhatsApp"
        description="Cada conexão é um número de WhatsApp, conectado como um aparelho (igual ao WhatsApp Web). O celular continua funcionando normalmente."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ name: '', color: '#FE5A51', enabled: true, allowed_sector_ids: [], settings: {} })}>
            Nova conexão
          </Button>
        }
      />
      {conns.isLoading ? (
        <Spinner />
      ) : !conns.data?.length ? (
        <div className="rounded-[12px] border border-line bg-panel">
          <Empty title="Nenhum número conectado ainda" action={<Button variant="primary" onClick={() => setEditing({ name: 'Comercial', color: '#FE5A51', enabled: true, allowed_sector_ids: [], settings: {} })}>Conectar o primeiro número</Button>}>
            Crie uma conexão e leia o QR Code com o celular do número que vai atender.
          </Empty>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {conns.data.map((c) => {
            const st = { ...c, ...live[c.id] }
            const meta = STATUS[st.status] ?? STATUS.disconnected!
            return (
              <div key={c.id} className="rounded-[12px] border border-line bg-panel p-5 shadow-panel">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-[10px] text-white" style={{ background: c.color }}>
                      <Smartphone className="size-5" />
                    </span>
                    <div>
                      <div className="font-semibold text-ink">{c.name}</div>
                      <div className="text-[12.5px] text-muted">{c.phone ? formatPhone(c.phone) : 'Número ainda não pareado'}</div>
                    </div>
                  </div>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </div>
                {st.error && st.status !== 'connected' && <p className="mt-3 rounded-[8px] bg-panel-2 px-3 py-2 text-[12.5px] text-ink-2">{st.error}</p>}
                <div className="mt-3 text-[12.5px] text-muted">
                  {c.active_conversations} conversas ativas
                  {c.last_connected_at && <> · conectado {ago(c.last_connected_at)}</>}
                  {!c.enabled && <> · desativada</>}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {st.status !== 'connected' && c.enabled && (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<QrCode className="size-4" />}
                      onClick={async () => {
                        setPairing(c.id)
                        try {
                          await api.post(`/api/connections/${c.id}/connect`)
                        } catch (e: any) {
                          toast.error(e.message)
                        }
                      }}
                    >
                      {st.status === 'logged_out' || !c.phone ? 'Gerar QR Code' : 'Reconectar'}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setEditing(c)}>
                    Configurar
                  </Button>
                  {st.status === 'connected' && (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Unplug className="size-4" />}
                      onClick={async () => {
                        if (!confirm(`Desconectar o aparelho "${c.name}"? Ele sai da lista de aparelhos conectados do celular e será preciso ler o QR Code de novo.`)) return
                        await api.post(`/api/connections/${c.id}/logout`).catch((e) => toast.error(e.message))
                        qc.invalidateQueries({ queryKey: ['connections'] })
                      }}
                    >
                      Desconectar aparelho
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-6 rounded-[12px] border border-line bg-panel-2/50 p-5 text-[13px] leading-relaxed text-ink-2">
        <div className="mb-1 font-semibold text-ink">Para proteger o número</div>
        Esta conexão usa o protocolo do WhatsApp Web (não é a API oficial). O sistema envia com ritmo humano — "digitando…", intervalos e limite por minuto — e não faz disparos em massa.
        Mesmo assim, evite iniciar muitas conversas novas em sequência com pessoas que nunca falaram com a empresa.
      </div>

      <PairDialog conn={pairingLive} onClose={() => setPairing(null)} />
      {editing && <ConnectionDialog conn={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function PairDialog({ conn, onClose }: { conn: any | null; onClose: () => void }) {
  return (
    <Dialog open={!!conn} onClose={onClose} title={`Conectar "${conn?.name ?? ''}"`} width={560}>
      {conn && (
        <div className="grid gap-6 sm:grid-cols-[260px_1fr]">
          <div className="flex aspect-square items-center justify-center rounded-[12px] border border-line bg-white p-3">
            {conn.status === 'qr' && conn.qr ? (
              <img src={conn.qr} alt="QR Code de pareamento" className="size-full" />
            ) : conn.status === 'connected' ? (
              <div className="text-center text-sm font-medium text-ok">Conectado!</div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-[13px] text-navy/70">
                <Spinner />
                Gerando QR Code…
              </div>
            )}
          </div>
          <ol className="space-y-3 text-[13.5px] text-ink-2">
            {[
              'Abra o WhatsApp no celular do número.',
              'Toque em ⋮ (Android) ou Configurações (iPhone) → Aparelhos conectados.',
              'Toque em "Conectar um aparelho" e aponte a câmera para o QR Code.',
              'Aguarde: no celular vai aparecer "Chrome (Windows)".',
            ].map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-[6px] text-[12px] font-semibold', 'bg-navy text-linen dark:bg-linen dark:text-navy')}>{i + 1}</span>
                <span>{t}</span>
              </li>
            ))}
            <li className="pt-1 text-[12.5px] text-muted">O QR Code se renova sozinho. Se expirar sem leitura, clique em "Gerar QR Code" de novo.</li>
            {conn.error && conn.status !== 'qr' && <li className="text-[12.5px] text-coral-ink">{conn.error}</li>}
          </ol>
        </div>
      )}
    </Dialog>
  )
}

function ConnectionDialog({ conn, onClose }: { conn: any; onClose: () => void }) {
  const sectors = useSectors()
  const qc = useQueryClient()
  const [f, setF] = useState({
    name: conn.name ?? '',
    color: conn.color ?? '#FE5A51',
    enabled: conn.enabled ?? true,
    defaultSectorId: conn.default_sector_id ?? '',
    allowedSectorIds: (conn.allowed_sector_ids ?? []) as string[],
    entryFlowId: conn.entry_flow_id ?? '',
    settings: conn.settings ?? {},
  })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const body = { ...f, defaultSectorId: f.defaultSectorId || null, entryFlowId: f.entryFlowId || null }
      if (conn.id) await api.put(`/api/connections/${conn.id}`, body)
      else await api.post('/api/connections', body)
      qc.invalidateQueries({ queryKey: ['connections'] })
      toast.success('Conexão salva.')
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  const active = (sectors.data ?? []).filter((s) => s.active)
  return (
    <Dialog
      open
      onClose={onClose}
      title={conn.id ? `Configurar "${conn.name}"` : 'Nova conexão'}
      width={560}
      footer={
        <>
          {conn.id && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                if (!confirm('Excluir esta conexão? Só é possível se ela não tiver conversas.')) return
                try {
                  await api.del(`/api/connections/${conn.id}`)
                  qc.invalidateQueries({ queryKey: ['connections'] })
                  onClose()
                } catch (e: any) {
                  toast.error(e.message)
                }
              }}
            >
              Excluir
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!f.name}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Nome da conexão" hint="Ex.: Comercial, Recepção">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Cor">
            <Input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-10 p-1" />
          </Field>
        </div>
        <Field label="Setor de entrada" hint="Para onde a conversa vai quando não houver fluxo/IA, ou quando a automação transferir sem indicar setor.">
          <Select value={f.defaultSectorId} onChange={(e) => setF({ ...f, defaultSectorId: e.target.value })}>
            <option value="">Primeiro setor ativo</option>
            {active.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink-2">Setores para onde esta conexão pode transferir</div>
          <div className="flex flex-wrap gap-2">
            {active.map((s) => {
              const on = f.allowedSectorIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setF({ ...f, allowedSectorIds: on ? f.allowedSectorIds.filter((x) => x !== s.id) : [...f.allowedSectorIds, s.id] })}
                  className={cx('rounded-[7px] border px-2.5 py-1 text-[13px]', on ? 'border-ink bg-ink text-bg' : 'border-line-strong text-ink-2')}
                >
                  {s.name}
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-[12px] text-muted">Nenhum selecionado = todos os setores.</p>
        </div>
        {connectionExtraFields.map((X, i) => (
          <X key={i} value={f} onChange={(patch: any) => setF({ ...f, ...patch })} />
        ))}
        <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Conexão ativa" description="Desativada, o número não recebe nem envia mensagens pelo sistema." />
      </div>
    </Dialog>
  )
}

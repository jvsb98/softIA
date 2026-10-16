import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, Lock, Plus, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Avatar, Badge, Button, cx, Dialog, Field, Input, PageHeader, Select, Spinner, Switch, Table } from '@/components/ui'
import { api } from '@/lib/api'
import { ago } from '@/lib/format'
import { useSectors, useUsers } from '@/lib/queries'
import { useSession } from '@/lib/session'

const ROLES: Record<string, { label: string; help: string }> = {
  admin: { label: 'Administrador', help: 'Acesso total: conexões, usuários, integrações, IA e segurança.' },
  supervisor: { label: 'Supervisor', help: 'Vê todas as conversas, gerencia setores, respostas rápidas e acompanha relatórios.' },
  agent: { label: 'Atendente', help: 'Atende as conversas dos seus setores.' },
}

export function UsersSettings() {
  const users = useUsers()
  const sectors = useSectors()
  const { me } = useSession()
  const [editing, setEditing] = useState<any | null>(null)
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null)
  const qc = useQueryClient()
  const isAdmin = me?.user.role === 'admin'
  const sectorName = (id: string) => sectors.data?.find((s) => s.id === id)?.name

  return (
    <div>
      <PageHeader
        title="Usuários"
        description="Quem acessa o Nimber Atende, com qual perfil e em quais setores."
        actions={
          isAdmin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ role: 'agent', active: true, sector_ids: [], permissions: {}, max_concurrent: 25 })}>
              Convidar usuário
            </Button>
          )
        }
      />
      {users.isLoading ? (
        <Spinner />
      ) : (
        <div className="rounded-[12px] border border-line bg-panel">
          <Table head={['Pessoa', 'Perfil', 'Setores', '2FA', 'Abertas', 'Último acesso', '']}>
            {users.data!.map((u) => (
              <tr key={u.id} className={cx(!u.active && 'opacity-50')}>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="relative">
                      <Avatar name={u.name} color={u.color} size={30} />
                      <span
                        className={cx('absolute -bottom-0.5 -right-0.5 size-2.5 rounded-[2px] ring-2 ring-panel', u.presence === 'online' ? 'bg-ok' : u.presence === 'away' ? 'bg-warn' : 'bg-line-strong')}
                      />
                    </div>
                    <div>
                      <div className="font-medium text-ink">{u.name}</div>
                      <div className="text-[12px] text-muted">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-ink-2">{ROLES[u.role]?.label}</td>
                <td className="px-3 py-2.5 text-[12.5px] text-ink-2">{u.sector_ids.map(sectorName).filter(Boolean).join(', ') || '—'}</td>
                <td className="px-3 py-2.5">{u.totp_enabled ? <Badge tone="ok">ativo</Badge> : <Badge>não</Badge>}</td>
                <td className="px-3 py-2.5 text-ink-2">{u.open_conversations}</td>
                <td className="px-3 py-2.5 text-[12.5px] text-muted">
                  {u.locked_until && new Date(u.locked_until) > new Date() ? <Badge tone="coral">bloqueado</Badge> : ago(u.last_seen_at ?? u.last_login_at) || 'nunca'}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {isAdmin && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                      Editar
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {editing && (
        <UserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSecret={(title, value) => setSecret({ title, value })}
          onSaved={() => qc.invalidateQueries({ queryKey: ['users'] })}
        />
      )}
      <Dialog open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ''} description="Mostrada só agora. Envie para a pessoa por um canal seguro; ela vai trocar no primeiro acesso.">
        <code className="block rounded-[8px] bg-panel-2 px-4 py-3 text-center text-lg font-semibold tracking-wide text-ink">{secret?.value}</code>
      </Dialog>
    </div>
  )
}

function UserDialog({ user, onClose, onSecret, onSaved }: { user: any; onClose: () => void; onSecret: (t: string, v: string) => void; onSaved: () => void }) {
  const sectors = useSectors()
  const [f, setF] = useState({
    name: user.name ?? '',
    email: user.email ?? '',
    role: user.role ?? 'agent',
    sectorIds: (user.sector_ids ?? []) as string[],
    maxConcurrent: user.max_concurrent ?? 25,
    active: user.active ?? true,
    permissions: { flowsAdvanced: false, flowsEdit: false, kbEdit: false, reports: false, ...(user.permissions ?? {}) },
  })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      if (user.id) {
        await api.put(`/api/users/${user.id}`, f)
        toast.success('Usuário atualizado.')
      } else {
        const r = await api.post('/api/users', f)
        if (r.temporaryPassword) onSecret(`Senha temporária de ${f.name}`, r.temporaryPassword)
      }
      onSaved()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  const action = async (path: string, ok: string) => {
    try {
      const r = await api.post(`/api/users/${user.id}/${path}`)
      if (r.temporaryPassword) onSecret(`Nova senha temporária de ${user.name}`, r.temporaryPassword)
      else toast.success(ok)
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    }
  }
  const perm = (k: keyof typeof f.permissions, label: string, description: string) => (
    <Switch
      checked={f.role === 'admin' || !!f.permissions[k]}
      disabled={f.role === 'admin'}
      onChange={(v) => setF({ ...f, permissions: { ...f.permissions, [k]: v } })}
      label={label}
      description={description}
    />
  )
  return (
    <Dialog
      open
      onClose={onClose}
      width={620}
      title={user.id ? user.name : 'Convidar usuário'}
      description={user.id ? undefined : 'Uma senha temporária será gerada. No primeiro acesso a pessoa define a própria senha.'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!f.name || !f.email}>
            {user.id ? 'Salvar' : 'Criar usuário'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="E-mail">
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Perfil" hint={ROLES[f.role]?.help}>
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {Object.entries(ROLES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Conversas simultâneas (máximo)">
            <Input type="number" min={1} max={200} value={f.maxConcurrent} onChange={(e) => setF({ ...f, maxConcurrent: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-ink-2">Setores</div>
            <div className="flex flex-wrap gap-2">
              {(sectors.data ?? []).map((s) => {
                const on = f.sectorIds.includes(s.id)
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setF({ ...f, sectorIds: on ? f.sectorIds.filter((x) => x !== s.id) : [...f.sectorIds, s.id] })}
                    className={cx('rounded-[7px] border px-2.5 py-1 text-[13px]', on ? 'border-ink bg-ink text-bg' : 'border-line-strong text-ink-2', !s.active && 'opacity-60')}
                  >
                    {s.name}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="space-y-3 rounded-[10px] border border-line p-3">
            {perm('flowsEdit', 'Editar fluxos', 'Textos, perguntas e caminhos dos fluxos.')}
            {perm('flowsAdvanced', 'Nós avançados', 'Código, requisições HTTP e webhooks nos fluxos.')}
            {perm('kbEdit', 'Base de conhecimento', 'Documentos e perguntas frequentes usados pela IA.')}
            {perm('reports', 'Relatórios', 'Indicadores de atendimento e de leads.')}
          </div>
          <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Acesso ativo" />
        </div>
      </div>
      {user.id && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button size="sm" icon={<KeyRound className="size-4" />} onClick={() => action('reset-password', '')}>
            Gerar nova senha
          </Button>
          {user.totp_enabled && (
            <Button size="sm" icon={<ShieldOff className="size-4" />} onClick={() => confirm('Remover o 2FA? A pessoa precisará configurar de novo no próximo acesso.') && action('reset-2fa', '2FA removido.')}>
              Remover 2FA
            </Button>
          )}
          {user.locked_until && new Date(user.locked_until) > new Date() && (
            <Button size="sm" icon={<Lock className="size-4" />} onClick={() => action('unlock', 'Acesso desbloqueado.')}>
              Desbloquear
            </Button>
          )}
        </div>
      )}
    </Dialog>
  )
}

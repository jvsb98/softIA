import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Plus, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Avatar, Badge, Button, Dialog, Field, Input, PageHeader, Select, Spinner, Switch, Table } from '../../components/ui'
import { api } from '../../lib/api'
import { ago } from '../../lib/format'
import { useSession } from '../../lib/session'
import { ROLE_LABEL } from './shared'

const ROLE_HELP: Record<string, string> = {
  admin: 'Tudo: clientes, situação e cobrança, equipe, provedores de IA.',
  implantador: 'Cria e configura clientes (módulos, limites, marca) e entra no ambiente deles.',
  suporte: 'Consulta clientes e entra no ambiente deles informando o motivo. Não altera configuração.',
}

interface Member {
  id: string
  name: string
  email: string
  role: 'admin' | 'implantador' | 'suporte'
  active: boolean
  totp_enabled: boolean
  last_login_at: string | null
  last_seen_at: string | null
  locked_until: string | null
}

export function TeamPage() {
  const { me } = useSession()
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['platform-team'], queryFn: () => api.get<Member[]>('/api/platform/team') })
  const isAdmin = me?.user.role === 'admin'
  const [editing, setEditing] = useState<Member | 'new' | null>(null)
  const [secret, setSecret] = useState<{ title: string; email: string; password: string } | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-team'] })

  return (
    <div className="mx-auto max-w-[1040px] px-10 py-8">
      <PageHeader
        title="Equipe do fornecedor"
        description="Quem acessa este painel. Todos entram com verificação em duas etapas."
        actions={
          isAdmin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Novo membro
            </Button>
          )
        }
      />
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        {Object.entries(ROLE_HELP).map(([k, v]) => (
          <div key={k} className="rounded-[10px] border border-line bg-panel px-4 py-3">
            <div className="text-[13.5px] font-medium text-ink">{ROLE_LABEL[k]}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">{v}</div>
          </div>
        ))}
      </div>
      <div className="rounded-[12px] border border-line bg-panel">
        {list.isLoading ? (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        ) : (
          <Table head={['Pessoa', 'Perfil', '2FA', 'Último acesso', '']}>
            {(list.data ?? []).map((u) => (
              <tr key={u.id} className={u.active ? '' : 'opacity-55'}>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={u.name} size={30} />
                    <div>
                      <div className="font-medium text-ink">
                        {u.name} {u.id === me?.user.id && <span className="text-[12px] font-normal text-muted">(você)</span>}
                      </div>
                      <div className="text-[12px] text-muted">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-ink-2">
                  {ROLE_LABEL[u.role]} {!u.active && <Badge>inativo</Badge>}
                </td>
                <td className="px-3 py-2.5">{u.totp_enabled ? <Badge tone="ok">ativo</Badge> : <Badge tone="warn">pendente</Badge>}</td>
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
        )}
      </div>
      {editing && (
        <MemberDialog
          member={editing === 'new' ? null : editing}
          self={editing !== 'new' && editing.id === me?.user.id}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            refresh()
            setEditing(null)
            if (s) setSecret(s)
          }}
        />
      )}
      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title={secret?.title ?? ''}
        description="A senha temporária aparece só agora. No primeiro acesso a pessoa cria a própria senha e configura a verificação em duas etapas."
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            Pronto
          </Button>
        }
      >
        {secret && (
          <div className="space-y-3">
            <dl className="grid grid-cols-[130px_1fr] gap-y-2 text-[13.5px]">
              <dt className="text-muted">E-mail</dt>
              <dd className="text-ink">{secret.email}</dd>
              <dt className="text-muted">Senha temporária</dt>
              <dd className="font-mono text-ink">{secret.password}</dd>
            </dl>
            <Button
              size="sm"
              icon={<Copy className="size-3.5" />}
              onClick={() => navigator.clipboard.writeText(`Painel: ${location.origin}\nE-mail: ${secret.email}\nSenha temporária: ${secret.password}`).then(() => toast.success('Copiado.'))}
            >
              Copiar acesso
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  )
}

function MemberDialog({
  member,
  self,
  onClose,
  onSaved,
}: {
  member: Member | null
  self: boolean
  onClose: () => void
  onSaved: (secret?: { title: string; email: string; password: string }) => void
}) {
  const [name, setName] = useState(member?.name ?? '')
  const [email, setEmail] = useState(member?.email ?? '')
  const [role, setRole] = useState<Member['role']>(member?.role ?? 'implantador')
  const [active, setActive] = useState(member?.active ?? true)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      if (member) {
        await api.put(`/api/platform/team/${member.id}`, { name, email, role, active })
        toast.success('Alterações salvas.')
        onSaved()
      } else {
        const r = await api.post('/api/platform/team', { name, email, role, active: true })
        onSaved({ title: `${name} foi adicionado(a)`, email, password: r.temporaryPassword })
      }
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  const resetPassword = async () => {
    try {
      const r = await api.post(`/api/platform/team/${member!.id}/reset-password`, {})
      onSaved({ title: `Nova senha para ${member!.name}`, email: member!.email, password: r.temporaryPassword })
    } catch (e: any) {
      toast.error(e.message)
    }
  }
  const reset2fa = async () => {
    try {
      await api.post(`/api/platform/team/${member!.id}/reset-2fa`, {})
      toast.success('Verificação em duas etapas redefinida. A pessoa configura de novo no próximo acesso.')
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={member ? `Editar ${member.name}` : 'Novo membro da equipe'}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} disabled={name.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => void save()}>
            {member ? 'Salvar' : 'Adicionar'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="E-mail">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Perfil" hint={self ? 'Você não pode tirar o seu próprio perfil de super admin.' : ROLE_HELP[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Member['role'])} disabled={self}>
            {Object.keys(ROLE_HELP).map((k) => (
              <option key={k} value={k}>
                {ROLE_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        {member && !self && <Switch checked={active} onChange={setActive} label="Acesso ativo" description="Desativar encerra as sessões abertas na hora." />}
        {member && !self && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <Button size="sm" icon={<KeyRound className="size-3.5" />} onClick={() => void resetPassword()}>
              Gerar nova senha
            </Button>
            {member.totp_enabled && (
              <Button size="sm" icon={<ShieldOff className="size-3.5" />} onClick={() => void reset2fa()}>
                Redefinir 2FA
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, LogIn } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, cx, Field, Input, PageHeader, PixelGlyph, Section, Select, Spinner, Switch, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { FLOW_MODES, slugify, useCatalog, type Limits } from './shared'

const STEPS = ['Empresa', 'Marca', 'Módulos e limites', 'Administrador', 'Revisão']

type ModMap = Record<string, { enabled: boolean; config: Record<string, any> }>

export function NewClientPage() {
  const catalog = useCatalog()
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [segment, setSegment] = useState('marmoraria')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [slugState, setSlugState] = useState<{ ok: boolean; error?: string; host?: string } | null>(null)
  const [productName, setProductName] = useState('')
  const [color, setColor] = useState('#FE5A51')
  const [logo, setLogo] = useState<File | null>(null)
  const [plan, setPlan] = useState('essencial')
  const [modules, setModules] = useState<ModMap>({})
  const [limits, setLimits] = useState<Limits | null>(null)
  const [adminName, setAdminName] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [contact, setContact] = useState({ name: '', phone: '', email: '' })
  const [notes, setNotes] = useState('')
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<any>(null)

  // Endereço sugerido a partir do nome, até a pessoa editar
  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name))
  }, [name, slugTouched])

  // Confere o endereço enquanto digita
  useEffect(() => {
    if (!slug) return setSlugState(null)
    const t = setTimeout(() => {
      api.get(`/api/platform/slug-check?slug=${encodeURIComponent(slug)}`).then(setSlugState, () => setSlugState(null))
    }, 350)
    return () => clearTimeout(t)
  }, [slug])

  // Plano escolhido preenche módulos e limites (ajustáveis item a item)
  useEffect(() => {
    const p = catalog.data?.plans.find((x) => x.key === plan)
    if (!p) return
    setModules(Object.fromEntries((catalog.data?.modules ?? []).filter((m) => !m.base).map((m) => [m.key, p.modules[m.key] ?? { enabled: false, config: {} }])))
    setLimits({ ...p.limits })
  }, [plan, catalog.data])

  const logoPreview = useMemo(() => (logo ? URL.createObjectURL(logo) : null), [logo])
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)
  const canNext = [name.trim().length >= 2 && !!slugState?.ok, /^#[0-9a-f]{6}$/i.test(color), !!limits, adminName.trim().length >= 2 && emailOk, true][step]

  if (catalog.isLoading || !catalog.data) return <div className="flex justify-center p-16"><Spinner /></div>
  const cat = catalog.data

  async function create() {
    setCreating(true)
    try {
      const r = await api.post('/api/platform/tenants', {
        name,
        slug,
        segment,
        plan,
        modules,
        limits,
        brand: { productName: productName.trim(), primaryColor: color },
        admin: { name: adminName, email: adminEmail },
        contact,
        notes: notes || null,
      })
      if (logo) {
        const form = new FormData()
        form.append('file', logo)
        await api.upload(`/api/platform/tenants/${r.id}/brand/logo`, form).catch((e) => toast.error(`Cliente criado, mas o logo não foi salvo: ${e.message}`))
      }
      qc.invalidateQueries({ queryKey: ['platform-tenants'] })
      setResult(r)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setCreating(false)
    }
  }

  if (result) return <Created r={result} productName={productName || name} />

  return (
    <div className="mx-auto max-w-[880px] px-10 py-8">
      <Link to="/clientes" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Clientes
      </Link>
      <PageHeader title="Novo cliente" description="Cinco passos. No fim, o ambiente fica no ar com a estrutura do segmento e o acesso do administrador pronto para enviar." />

      <ol className="mb-6 grid grid-cols-5 gap-2">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              disabled={i > step}
              onClick={() => i < step && setStep(i)}
              className={cx('w-full border-t-2 pt-2 text-left text-[12.5px]', i < step ? 'border-ok text-ink-2' : i === step ? 'border-coral font-medium text-ink' : 'border-line text-muted')}
            >
              <span className="tabular-nums">{i + 1}.</span> {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Section title="Empresa" description="Nome, segmento e o endereço onde o cliente vai acessar.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Nome da empresa">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Marmoraria São José" autoFocus />
            </Field>
            <Field label="Segmento" hint="Define o modelo de setores, fluxos e funil (Fase 4).">
              <Select value={segment} onChange={(e) => setSegment(e.target.value)}>
                {cat.segments.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Endereço"
              className="md:col-span-2"
              error={slugState && !slugState.ok ? slugState.error : null}
              hint={slugState?.ok ? <span className="text-ok">Disponível: {slugState.host}</span> : `Fica em <endereço>.${cat.baseDomain}`}
            >
              <div className="flex items-center gap-2">
                <Input
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true)
                    setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }}
                  className="max-w-[280px]"
                />
                <span className="text-[13.5px] text-muted">.{cat.baseDomain}</span>
              </div>
            </Field>
            <Field label="Contato do cliente (opcional)">
              <Input value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} placeholder="Nome de quem contratou" />
            </Field>
            <Field label="Telefone (opcional)">
              <Input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} placeholder="(41) 99999-0000" />
            </Field>
          </div>
        </Section>
      )}

      {step === 1 && (
        <Section title="Marca" description="O cliente vê a própria marca no login e no painel. Nada do nome do fornecedor aparece para ele.">
          <div className="grid gap-6 md:grid-cols-[1fr_300px]">
            <div className="space-y-4">
              <Field label="Nome do produto" hint="Aparece no título da aba e no login. Em branco, usa o nome da empresa.">
                <Input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder={name || 'Atendimento São José'} maxLength={40} />
              </Field>
              <Field label="Cor principal" hint="Botões e destaques. Escolha uma cor escura o bastante para o texto branco.">
                <div className="flex items-center gap-3">
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-14 cursor-pointer rounded-[8px] border border-line-strong bg-panel" aria-label="Cor principal" />
                  <Input value={color} onChange={(e) => setColor(e.target.value)} className="max-w-[140px] font-mono" />
                </div>
              </Field>
              <Field label="Logo (opcional)" hint="PNG, JPG ou WEBP, até 300 KB. Também vira o ícone da aba.">
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} className="text-[13px]" />
              </Field>
            </div>
            <div>
              <div className="mb-2 text-[12px] font-medium text-muted">Prévia do login</div>
              <div className="rounded-[12px] border border-line bg-bg p-5">
                <div className="flex items-center gap-2">
                  {logoPreview ? <img src={logoPreview} alt="" className="h-8 max-w-[140px] object-contain" /> : <span style={{ color }}><PixelGlyph pattern="mark" size={20} /></span>}
                  {!logoPreview && <span className="text-[14px] font-semibold text-ink">{productName || name || 'Nome do produto'}</span>}
                </div>
                <div className="mt-6 font-display text-[22px] text-ink">Entrar</div>
                <div className="mt-3 h-9 rounded-[8px] border border-line-strong bg-panel" />
                <div className="mt-2 h-9 rounded-[8px] border border-line-strong bg-panel" />
                <div className="mt-3 flex h-9 items-center justify-center rounded-[8px] text-[13px] font-medium text-white" style={{ background: color }}>
                  Entrar
                </div>
              </div>
            </div>
          </div>
        </Section>
      )}

      {step === 2 && limits && (
        <div className="space-y-5">
          <Section title="Plano de referência" description="Só um atalho: preenche módulos e limites. Ajuste item a item abaixo.">
            <div className="grid gap-3 md:grid-cols-3">
              {cat.plans.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPlan(p.key)}
                  className={cx('rounded-[10px] border p-4 text-left transition-colors', plan === p.key ? 'border-coral bg-coral-soft' : 'border-line hover:bg-panel-2')}
                >
                  <div className="font-medium text-ink">{p.label}</div>
                  <div className="mt-1 text-[12.5px] text-muted">{p.description}</div>
                </button>
              ))}
            </div>
          </Section>
          <ModulesEditor catalog={cat} modules={modules} onChange={setModules} />
          <LimitsEditor limits={limits} onChange={setLimits} aiOn={!!modules.ia?.enabled} />
        </div>
      )}

      {step === 3 && (
        <Section title="Administrador do cliente" description="Recebe uma senha temporária. No primeiro acesso cria a própria senha e ativa a verificação em duas etapas.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Nome">
              <Input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Nome do dono ou gerente" autoFocus />
            </Field>
            <Field label="E-mail" error={adminEmail && !emailOk ? 'E-mail inválido' : null}>
              <Input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="email@empresa.com.br" />
            </Field>
            <Field label="Observações internas (opcional)" className="md:col-span-2" hint="Só a equipe do fornecedor vê. Ex.: valor e dia da cobrança manual.">
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </Section>
      )}

      {step === 4 && limits && (
        <Section title="Revisão" description="Confira antes de criar. Tudo pode ser ajustado depois na ficha do cliente.">
          <dl className="grid gap-x-6 gap-y-3 text-[13.5px] md:grid-cols-[180px_1fr]">
            <dt className="text-muted">Empresa</dt>
            <dd className="text-ink">
              {name} · {cat.segments.find((s) => s.key === segment)?.label}
            </dd>
            <dt className="text-muted">Endereço</dt>
            <dd className="text-ink">{slugState?.host}</dd>
            <dt className="text-muted">Marca</dt>
            <dd className="flex items-center gap-2 text-ink">
              <span className="inline-block size-4 rounded-[4px]" style={{ background: color }} /> {productName || name}
              {logo && <Badge>com logo</Badge>}
            </dd>
            <dt className="text-muted">Módulos</dt>
            <dd className="text-ink">
              {cat.modules
                .filter((m) => m.base || modules[m.key]?.enabled)
                .map((m) => m.label + (m.key === 'fluxos' ? ` (${FLOW_MODES[modules.fluxos?.config.edicao ?? 'fornecedor']?.toLowerCase()})` : '') + (!m.available ? ' — em breve' : ''))
                .join(' · ')}
            </dd>
            <dt className="text-muted">Limites</dt>
            <dd className="text-ink">
              {limits.maxConnections} número(s) · {limits.maxUsers} usuário(s) · {limits.maxProfessionals} profissional(is)
              {modules.ia?.enabled ? ` · IA: ${limits.aiTokensMonth ? `${limits.aiTokensMonth.toLocaleString('pt-BR')} tokens/mês (${limits.aiOverage})` : 'sem franquia'}` : ''}
            </dd>
            <dt className="text-muted">Administrador</dt>
            <dd className="text-ink">
              {adminName} · {adminEmail}
            </dd>
          </dl>
        </Section>
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" icon={<ArrowLeft className="size-4" />} disabled={step === 0} onClick={() => setStep(step - 1)}>
          Voltar
        </Button>
        {step < 4 ? (
          <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Continuar <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button variant="primary" loading={creating} icon={<Check className="size-4" />} onClick={() => void create()}>
            {creating ? 'Criando o ambiente…' : 'Criar cliente'}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Liga/desliga módulos e define o modo de edição dos fluxos (usado na criação e na ficha). */
export function ModulesEditor({ catalog, modules, onChange, footer }: { catalog: NonNullable<ReturnType<typeof useCatalog>['data']>; modules: ModMap; onChange: (m: ModMap) => void; footer?: React.ReactNode }) {
  const set = (key: string, v: Partial<{ enabled: boolean; config: Record<string, any> }>) =>
    onChange({ ...modules, [key]: { enabled: modules[key]?.enabled ?? false, config: modules[key]?.config ?? {}, ...v } })
  return (
    <Section title="Módulos" description="Módulo desligado some do menu do cliente e a API recusa. Base vale para todos.">
      <div className="divide-y divide-line">
        {catalog.modules.map((m) => (
          <div key={m.key} className="flex items-start justify-between gap-6 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                {m.label}
                {m.base && <Badge>base</Badge>}
                {!m.available && <Badge tone="warn">em breve · {m.phase}</Badge>}
              </div>
              <div className="text-[12.5px] text-muted">{m.description}</div>
              {m.key === 'fluxos' && modules.fluxos?.enabled && (
                <Select value={modules.fluxos.config.edicao ?? 'fornecedor'} onChange={(e) => set('fluxos', { config: { ...modules.fluxos!.config, edicao: e.target.value } })} className="mt-2 max-w-[320px]">
                  {Object.entries(FLOW_MODES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            {m.base ? (
              <span className="shrink-0 text-[12.5px] text-muted">Incluído</span>
            ) : (
              <Switch checked={!!modules[m.key]?.enabled} disabled={!m.available && !modules[m.key]?.enabled} onChange={(v) => set(m.key, { enabled: v, config: m.key === 'fluxos' && !modules.fluxos?.config.edicao ? { edicao: 'fornecedor' } : modules[m.key]?.config ?? {} })} />
            )}
          </div>
        ))}
      </div>
      {footer && <div className="mt-4">{footer}</div>}
    </Section>
  )
}

export function LimitsEditor({ limits, onChange, aiOn, footer }: { limits: Limits; onChange: (l: Limits) => void; aiOn: boolean; footer?: React.ReactNode }) {
  const num = (k: keyof Limits) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...limits, [k]: Math.max(0, Number(e.target.value) || 0) })
  return (
    <Section title="Limites" description="Conferidos no servidor. Ao chegar ao limite, o cliente vê uma mensagem pedindo para falar com o fornecedor.">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Números de WhatsApp">
          <Input type="number" min={0} value={limits.maxConnections} onChange={num('maxConnections')} />
        </Field>
        <Field label="Usuários ativos" hint="O acesso do fornecedor não conta.">
          <Input type="number" min={1} value={limits.maxUsers} onChange={num('maxUsers')} />
        </Field>
        <Field label="Profissionais na agenda" hint="Vale quando a agenda chegar (Fase 3).">
          <Input type="number" min={0} value={limits.maxProfessionals} onChange={num('maxProfessionals')} />
        </Field>
        {aiOn && (
          <>
            <Field label="Franquia de IA (tokens por mês)" hint="0 = sem franquia definida." className="md:col-span-2">
              <Input type="number" min={0} step={100000} value={limits.aiTokensMonth} onChange={num('aiTokensMonth')} />
            </Field>
            <Field label="Ao estourar a franquia">
              <Select value={limits.aiOverage} onChange={(e) => onChange({ ...limits, aiOverage: e.target.value as Limits['aiOverage'] })}>
                <option value="bloquear">Bloquear a IA</option>
                <option value="avisar">Só avisar</option>
              </Select>
            </Field>
          </>
        )}
      </div>
      {footer && <div className="mt-4">{footer}</div>}
    </Section>
  )
}

function Created({ r, productName }: { r: any; productName: string }) {
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const [entering, setEntering] = useState(false)
  return (
    <div className="mx-auto max-w-[720px] px-10 py-12">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-ok/15 text-ok">
          <Check className="size-5" />
        </span>
        <div>
          <h1 className="font-display text-[26px] text-ink">{productName} está no ar</h1>
          <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13.5px] text-muted hover:text-ink">
            {r.url} <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>
      <Section title="Acesso do administrador" description="A senha temporária aparece só agora. Envie a mensagem abaixo pelo WhatsApp do cliente.">
        <dl className="mb-4 grid grid-cols-[140px_1fr] gap-y-2 text-[13.5px]">
          <dt className="text-muted">E-mail</dt>
          <dd className="text-ink">{r.adminEmail}</dd>
          <dt className="text-muted">Senha temporária</dt>
          <dd className="font-mono text-ink">{r.temporaryPassword}</dd>
        </dl>
        <Textarea readOnly rows={7} value={r.whatsappMessage} className="font-mono text-[12.5px]" />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            onClick={() => navigator.clipboard.writeText(r.whatsappMessage).then(() => (setCopied(true), toast.success('Mensagem copiada.')))}
          >
            {copied ? 'Copiada' : 'Copiar mensagem'}
          </Button>
          <Button
            variant="primary"
            loading={entering}
            icon={<LogIn className="size-4" />}
            onClick={async () => {
              setEntering(true)
              try {
                const x = await api.post(`/api/platform/tenants/${r.id}/impersonate`, { reason: 'Implantação inicial' })
                window.open(x.url, '_blank', 'noopener')
              } catch (e: any) {
                toast.error(e.message)
              } finally {
                setEntering(false)
              }
            }}
          >
            Entrar como cliente para implantar
          </Button>
          <Button variant="ghost" onClick={() => navigate(`/clientes/${r.id}`)}>
            Abrir a ficha do cliente
          </Button>
        </div>
      </Section>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { Check, Copy, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button, Field, Input, Logo, PixelGlyph, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'

/** Moldura das telas de acesso: painel à esquerda, campo de "frações" à direita. */
function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(420px,520px)_1fr]">
      <div className="flex flex-col justify-between bg-bg px-8 py-10 sm:px-14">
        <Logo />
        <div className="my-12 w-full max-w-[360px]">
          <h1 className="font-display text-[34px] leading-[1.1] text-ink">{title}</h1>
          {subtitle && <p className="mt-3 text-[15px] leading-relaxed text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
        <p className="text-[12px] text-muted">Acesso restrito à equipe. Acessos são registrados.</p>
      </div>
      <FractionField />
    </div>
  )
}

/** Campo de frações: o ativo inteiro (navy) se revelando ponto a ponto — referência ao "Fluid Logo" da marca. */
function FractionField() {
  const cols = 14
  const rows = 18
  const cells = Array.from({ length: cols * rows }, (_, i) => {
    const x = i % cols
    const y = Math.floor(i / cols)
    const v = Math.sin(x * 1.7 + y * 0.9) + Math.cos(x * 0.6 - y * 1.3)
    return v > 1.1 ? 'coral' : v > 0.35 ? 'nimbus' : v < -1.3 ? 'linen' : null
  })
  return (
    <div className="relative hidden overflow-hidden bg-navy lg:block" aria-hidden>
      <div className="absolute inset-0 grid p-10" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 10 }}>
        {cells.map((c, i) => (
          <div
            key={i}
            className="aspect-square rounded-[3px]"
            style={{
              background: c === 'coral' ? '#FE5A51' : c === 'nimbus' ? 'rgb(153 193 228 / 0.55)' : c === 'linen' ? 'rgb(246 241 231 / 0.12)' : 'rgb(246 241 231 / 0.035)',
            }}
          />
        ))}
      </div>
      <div className="absolute inset-x-10 bottom-10 max-w-md text-linen">
        <div className="font-display text-[30px] leading-tight">Cada conversa, uma fração de valor.</div>
        <p className="mt-2 text-[14px] text-linen/70">Atendimento, qualificação e IA num só lugar, no número que seus clientes já conhecem.</p>
      </div>
    </div>
  )
}

export function SetupPage() {
  const { refresh } = useSession()
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post('/api/setup/admin', form)
      await refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <AuthFrame title="Vamos configurar o atendimento" subtitle="Crie a conta de administrador. Em seguida você ativa a verificação em duas etapas e conecta o primeiro número de WhatsApp.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome da empresa">
          <Input value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} />
        </Field>
        <Field label="Seu nome">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
        </Field>
        <Field label="E-mail">
          <Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
        </Field>
        <Field label="Senha" hint="Mínimo de 10 caracteres, com letras e números.">
          <Input required type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
        </Field>
        <Button variant="primary" className="w-full" loading={busy}>
          Criar administrador
        </Button>
      </form>
    </AuthFrame>
  )
}

/**
 * Depois do login, abre o painel com um carregamento completo da página (em vez de trocar a tela no lugar).
 * Evita que extensões do navegador que mexem nos campos de login (gerenciador de senhas, tradutor)
 * deixem a página em branco na transição.
 */
function openPanel() {
  window.location.replace('/atendimento')
}

export function LoginPage() {
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      if (step === 'password') {
        const r = await api.post<{ mfaRequired: boolean }>('/api/auth/login', { email, password })
        if (r.mfaRequired) setStep('code')
        else openPanel()
      } else {
        await api.post('/api/auth/2fa/verify', { code })
        openPanel()
      }
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame
      title={step === 'password' ? 'Entrar' : 'Verificação em duas etapas'}
      subtitle={step === 'code' ? 'Digite o código de 6 dígitos do seu app autenticador. Sem acesso ao celular? Use um código de recuperação.' : undefined}
    >
      <form onSubmit={submit} className="space-y-4">
        {step === 'password' ? (
          <>
            <Field label="E-mail">
              <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />
            </Field>
            <Field label="Senha">
              <Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
          </>
        ) : (
          <Field label="Código">
            <Input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="text-center text-lg tracking-[0.35em]"
              autoFocus
              maxLength={12}
            />
          </Field>
        )}
        <Button variant="primary" className="w-full" loading={busy}>
          {step === 'password' ? 'Entrar' : 'Confirmar código'}
        </Button>
        {step === 'code' && (
          <button type="button" className="w-full text-center text-[13px] text-muted hover:text-ink" onClick={() => setStep('password')}>
            Voltar
          </button>
        )}
      </form>
    </AuthFrame>
  )
}

export function TwoFactorSetupPage({ mandatory, onDone }: { mandatory?: boolean; onDone?: () => void }) {
  const { refresh, logout } = useSession()
  const setup = useQuery({ queryKey: ['2fa-setup'], queryFn: () => api.post<{ secret: string; qr: string }>('/api/auth/2fa/setup'), staleTime: Infinity, retry: false })
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const confirm = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/confirm', { code })
      setCodes(r.recoveryCodes)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (codes) {
    return (
      <AuthFrame title="Guarde seus códigos de recuperação" subtitle="Cada código funciona uma vez, caso você perca o acesso ao app autenticador. Guarde em local seguro (gerenciador de senhas).">
        <div className="grid grid-cols-2 gap-2 rounded-[10px] border border-line bg-panel p-4 font-medium tracking-wider">
          {codes.map((c) => (
            <code key={c} className="text-center text-[15px]">
              {c}
            </code>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <Button
            icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            onClick={() => {
              navigator.clipboard?.writeText(codes.join('\n'))
              setCopied(true)
            }}
          >
            {copied ? 'Copiados' : 'Copiar'}
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            onClick={async () => {
              if (mandatory) return openPanel()
              await refresh()
              onDone?.()
            }}
          >
            Já guardei, continuar
          </Button>
        </div>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame
      title="Ative a verificação em duas etapas"
      subtitle={
        mandatory
          ? 'A política de segurança exige o segundo fator para o seu perfil. Escaneie o QR Code com Google Authenticator, Microsoft Authenticator ou similar.'
          : 'Escaneie o QR Code com o app autenticador do celular.'
      }
    >
      {setup.isLoading ? (
        <Spinner />
      ) : setup.error ? (
        <p className="text-sm text-coral-ink">{(setup.error as Error).message}</p>
      ) : (
        <form onSubmit={confirm} className="space-y-4">
          <div className="flex items-center gap-4 rounded-[12px] border border-line bg-panel p-4">
            <img src={setup.data!.qr} alt="QR Code para o app autenticador" className="size-36 rounded-[8px] bg-white p-1" />
            <div className="min-w-0 text-[12px] text-muted">
              <ShieldCheck className="mb-2 size-5 text-ok" />
              Não consegue escanear? Digite a chave:
              <code className="mt-1 block break-all text-[12.5px] font-semibold text-ink">{setup.data!.secret.match(/.{1,4}/g)?.join(' ')}</code>
            </div>
          </div>
          <Field label="Código gerado pelo app">
            <Input required inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className="text-center text-lg tracking-[0.35em]" />
          </Field>
          <Button variant="primary" className="w-full" loading={busy}>
            Ativar
          </Button>
          {mandatory && (
            <button type="button" onClick={() => void logout()} className="w-full text-center text-[13px] text-muted hover:text-ink">
              Sair
            </button>
          )}
        </form>
      )}
    </AuthFrame>
  )
}

export function ChangePasswordPage() {
  const { refresh } = useSession()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <AuthFrame title="Defina sua senha" subtitle="Você entrou com uma senha temporária. Escolha uma senha pessoal para continuar.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            await api.post('/api/auth/password', { current: cur, next })
            toast.success('Senha alterada.')
            await refresh()
          } catch (err: any) {
            toast.error(err.message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Senha temporária">
          <Input type="password" required value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="Nova senha" hint="Mínimo de 10 caracteres, com letras e números.">
          <Input type="password" required value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Button variant="primary" className="w-full" loading={busy}>
          Salvar senha
        </Button>
      </form>
    </AuthFrame>
  )
}

export function BootScreen() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 4000)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-muted">
      <PixelGlyph pattern="mark" size={36} className="animate-pulse text-coral" />
      {slow && <p className="text-sm">Conectando ao servidor…</p>}
    </div>
  )
}

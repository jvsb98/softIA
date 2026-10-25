import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Rede de proteção do painel: um erro ao montar qualquer tela deixava a página inteira em branco.
 * Agora:
 *  - erros de DOM causados por extensões do navegador (gerenciador de senhas, tradutor) que mexem nos
 *    campos → recarrega a página uma vez, sozinho (a sessão continua válida);
 *  - qualquer outro erro → mostra a mensagem, com botões para recarregar ou sair, em vez da tela vazia.
 */
const RELOAD_KEY = 'na:auto-reload-at'

function isDomConflict(err: Error) {
  return (
    err?.name === 'NotFoundError' ||
    /removeChild|insertBefore|not a child of this node|Failed to execute '(removeChild|insertBefore)'/i.test(String(err?.message))
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; stack: string }> {
  state = { error: null as Error | null, stack: '' }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[softIA] Erro na tela:', error, info.componentStack)
    this.setState({ stack: (info.componentStack ?? '').trim().split('\n').slice(0, 6).join('\n') })
    if (isDomConflict(error)) {
      let last = 0
      try {
        last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
      } catch {
        /* sem sessionStorage */
      }
      if (Date.now() - last > 15_000) window.location.reload()
    }
  }

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    const text = `${error.name}: ${error.message}\n${stack}`
    return (
      <div className="grid min-h-full place-items-center bg-bg p-6 text-ink">
        <div className="w-full max-w-[560px] rounded-[14px] border border-line bg-panel p-6">
          <h1 className="font-serif text-[26px] leading-tight">Esta tela não abriu</h1>
          <p className="mt-2 text-[14px] text-ink-2">
            Sua sessão continua ativa. Recarregue a página. Se o erro voltar, envie a mensagem abaixo para a equipe de tecnologia e tente numa janela anônima
            (extensões do navegador, como gerenciadores de senha e tradutores, às vezes interferem).
          </p>
          <pre className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap rounded-[8px] bg-panel-2 p-3 text-[12px] text-ink-2">{text}</pre>
          <div className="mt-5 flex flex-wrap gap-2">
            <button className="h-10 rounded-[10px] bg-coral px-4 text-[14px] font-medium text-white" onClick={() => window.location.reload()}>
              Recarregar
            </button>
            <button
              className="h-10 rounded-[10px] border border-line px-4 text-[14px] text-ink"
              onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}
            >
              Copiar mensagem
            </button>
            <button
              className="h-10 rounded-[10px] px-4 text-[14px] text-muted hover:text-ink"
              onClick={() => fetch('/api/auth/logout', { method: 'POST' }).finally(() => window.location.assign('/'))}
            >
              Sair
            </button>
          </div>
        </div>
      </div>
    )
  }
}

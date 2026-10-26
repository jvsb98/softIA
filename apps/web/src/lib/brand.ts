import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export interface Brand {
  scope: 'tenant' | 'platform'
  productName: string
  orgName: string
  primaryColor: string | null
  logoUrl: string | null
}

const FALLBACK: Brand = { scope: 'tenant', productName: 'softIA', orgName: '', primaryColor: null, logoUrl: null }

/** Marca do ambiente (white label do cliente ou do painel do fornecedor), lida uma vez por carregamento. */
export function useBrand() {
  return useQuery({
    queryKey: ['brand'],
    queryFn: async () => {
      const b = await api.get<Brand>('/api/brand').catch(() => FALLBACK)
      applyBrand(b)
      return b
    },
    staleTime: Infinity,
  })
}

/** Nome do produto já carregado (para títulos de aba), sem esperar a consulta. */
let current: Brand = FALLBACK
export const brandName = () => current.productName

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** Escurece a cor para textos e bordas (contraste sobre fundo claro). */
function shade(hex: string, f: number) {
  const { r, g, b } = hexToRgb(hex)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `#${[c(r), c(g), c(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export function applyBrand(b: Brand) {
  current = b
  document.title = b.productName
  const root = document.documentElement
  if (b.primaryColor && /^#[0-9a-f]{6}$/i.test(b.primaryColor)) {
    const { r, g, bl } = { ...hexToRgb(b.primaryColor), bl: hexToRgb(b.primaryColor).b }
    // A cor principal do cliente substitui o coral (ações humanas/primárias) nos dois temas
    const style = document.getElementById('brand-vars') ?? Object.assign(document.createElement('style'), { id: 'brand-vars' })
    style.textContent = `:root,[data-theme='dark']{--coral:${b.primaryColor};--coral-soft:rgb(${r} ${g} ${bl} / 0.13)}
:root{--coral-ink:${shade(b.primaryColor, 0.78)}}[data-theme='dark']{--coral-ink:${shade(b.primaryColor, 1.35)}}`
    document.head.appendChild(style)
  }
  if (b.logoUrl) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = b.logoUrl
  }
  void root
}

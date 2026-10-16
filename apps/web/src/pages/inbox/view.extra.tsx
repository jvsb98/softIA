import type { ComponentType } from 'react'

/** Faixas extras exibidas acima das mensagens (ex.: cartão de contexto da IA na transferência). */
export const viewExtras: ComponentType<{ conversation: any; onUseDraft: (text: string) => void }>[] = []

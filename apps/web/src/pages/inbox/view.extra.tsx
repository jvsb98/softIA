import type { ComponentType } from 'react'
import { AiAssistBar } from '../ai/AiAssist'

/** Faixas extras exibidas acima das mensagens (ex.: cartão de contexto da IA na transferência). */
export const viewExtras: ComponentType<{ conversation: any; onUseDraft: (text: string) => void }>[] = [AiAssistBar]

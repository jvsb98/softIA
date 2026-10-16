import type { ComponentType } from 'react'

/** Blocos extras do painel lateral (score, cartão de contexto da IA etc.), registrados pelas fases seguintes. */
export const contextExtras: ComponentType<{ conversation: any; contact: any }>[] = []

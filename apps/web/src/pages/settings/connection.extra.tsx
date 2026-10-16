import type { ComponentType } from 'react'

/** Campos extras no formulário da conexão (ex.: fluxo de entrada, na fase 3). */
export const connectionExtraFields: ComponentType<{ value: any; onChange: (patch: any) => void }>[] = []

import { useQuery } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Field, Select } from '@/components/ui'
import { api } from '@/lib/api'

function EntryFlowField({ value, onChange }: { value: any; onChange: (patch: any) => void }) {
  const flows = useQuery({ queryKey: ['flows'], queryFn: () => api.get<any[]>('/api/flows') })
  return (
    <Field label="Fluxo de entrada" hint="Sem fluxo, o agente de IA padrão atende. O fluxo precisa estar publicado.">
      <Select value={value.entryFlowId ?? ''} onChange={(e) => onChange({ entryFlowId: e.target.value })}>
        <option value="">Nenhum — agente de IA padrão</option>
        {(flows.data ?? [])
          .filter((f) => !f.archived)
          .map((f) => (
            <option key={f.id} value={f.id} disabled={!f.published_version}>
              {f.name}
              {f.published_version ? ` (v${f.published_version})` : ' — não publicado'}
            </option>
          ))}
      </Select>
    </Field>
  )
}

/** Campos extras no formulário da conexão (ex.: fluxo de entrada, na fase 3). */
export const connectionExtraFields: ComponentType<{ value: any; onChange: (patch: any) => void }>[] = [EntryFlowField]

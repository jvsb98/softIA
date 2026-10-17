import { lazy, Suspense, type ReactNode } from 'react'
import { Route } from 'react-router-dom'
import { Spinner } from './components/ui'
import { KnowledgePage } from './pages/ai/KnowledgePage'
import { FlowsPage } from './pages/flows/FlowsPage'

// Editor de fluxos (React Flow) e relatórios carregam sob demanda: o atendimento abre mais rápido.
const FlowEditorPage = lazy(() => import('./pages/flows/FlowEditor').then((m) => ({ default: m.FlowEditorPage })))
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })))

const L = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    }
  >
    {children}
  </Suspense>
)

/** Rotas dos módulos das fases seguintes (IA, fluxos, relatórios). */
export function extraRoutes() {
  return [
    <Route key="kb" path="/conhecimento" element={<KnowledgePage />} />,
    <Route key="flows" path="/fluxos" element={<FlowsPage />} />,
    <Route key="flow" path="/fluxos/:id" element={<L><FlowEditorPage /></L>} />,
    <Route key="reports" path="/relatorios" element={<L><ReportsPage /></L>} />,
  ]
}

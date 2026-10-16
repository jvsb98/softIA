import { Route } from 'react-router-dom'
import { KnowledgePage } from './pages/ai/KnowledgePage'
import { FlowEditorPage } from './pages/flows/FlowEditor'
import { FlowsPage } from './pages/flows/FlowsPage'

/** Rotas dos módulos das fases seguintes (IA, fluxos, relatórios). */
export function extraRoutes() {
  return [
    <Route key="kb" path="/conhecimento" element={<KnowledgePage />} />,
    <Route key="flows" path="/fluxos" element={<FlowsPage />} />,
    <Route key="flow" path="/fluxos/:id" element={<FlowEditorPage />} />,
  ]
}

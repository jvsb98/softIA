import { Route } from 'react-router-dom'
import { KnowledgePage } from './pages/ai/KnowledgePage'

/** Rotas dos módulos das fases seguintes (IA, fluxos, relatórios). */
export function extraRoutes() {
  return [<Route key="kb" path="/conhecimento" element={<KnowledgePage />} />]
}

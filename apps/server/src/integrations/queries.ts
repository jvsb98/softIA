/**
 * Consultas cadastradas a bases externas (implementação completa na fase 4).
 */
export async function executeSavedQuery(
  _queryId: string,
  _params: Record<string, any>,
  _ctx: { conversationId?: string | null; actor: 'ai' | 'flow' | 'agent' | 'test'; userId?: string | null },
): Promise<{ rows: any[]; error?: string }> {
  return { rows: [], error: 'Consultas a bases externas chegam na fase 4' }
}

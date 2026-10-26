-- =====================================================================
-- softIA · schema do cliente · 005 · Acesso do fornecedor ("entrar como cliente")
-- =====================================================================

-- Usuário técnico de cada pessoa da equipe do fornecedor que entrou neste cliente.
-- Não aparece nas listas, não conta no limite de usuários e não tem senha utilizável.
ALTER TABLE users ADD COLUMN platform_user_id uuid UNIQUE;

-- Sessões abertas pelo fornecedor: quem entrou (id na plataforma), por quê, e duram no máximo 2 horas.
ALTER TABLE user_sessions ADD COLUMN impersonated_by uuid;
ALTER TABLE user_sessions ADD COLUMN impersonated_by_name text;
ALTER TABLE user_sessions ADD COLUMN impersonation_reason text;

-- Os provedores de IA passaram para a plataforma (chaves do fornecedor); estas tabelas ficam sem uso.
COMMENT ON TABLE ai_providers IS 'Sem uso desde a 0.2.0: provedores ficam em plataforma.ai_providers';
COMMENT ON TABLE ai_task_models IS 'Sem uso desde a 0.2.0: modelos por tarefa ficam em plataforma.ai_task_models';

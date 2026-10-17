-- =====================================================================
-- Nimber Atende · 004 · Integrações, follow-ups, feriados e webhooks
-- =====================================================================

CREATE TABLE external_databases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('postgres','mysql','mssql')),
  host         text NOT NULL,
  port         int NOT NULL,
  database     text NOT NULL,
  username     text NOT NULL,
  password_enc text,
  ssl          text NOT NULL DEFAULT 'false' CHECK (ssl IN ('false','true','no-verify')),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saved_queries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id           uuid NOT NULL REFERENCES external_databases(id) ON DELETE CASCADE,
  name                  text NOT NULL UNIQUE,      -- identificador da ferramenta para a IA (ex.: ofertas_abertas)
  label                 text NOT NULL,
  description           text NOT NULL,             -- quando usar (lido pela IA)
  sql                   text NOT NULL,             -- SELECT com parâmetros nomeados :param
  params                jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name,type,description,required}]
  output_fields         text[] NOT NULL DEFAULT '{}',        -- vazio = todos
  masks                 jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {campo: cpf|email|phone|partial|hide}
  max_rows              int NOT NULL DEFAULT 20,
  timeout_ms            int NOT NULL DEFAULT 5000,
  requires_verification boolean NOT NULL DEFAULT false,
  is_verification       boolean NOT NULL DEFAULT false,
  ai_enabled            boolean NOT NULL DEFAULT true,
  enabled               boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE query_runs (
  id              bigserial PRIMARY KEY,
  query_id        uuid REFERENCES saved_queries(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  actor           text NOT NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  params_masked   jsonb NOT NULL DEFAULT '{}'::jsonb,
  rows            int,
  ms              int,
  ok              boolean NOT NULL,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX query_runs_created_idx ON query_runs(created_at DESC);

CREATE TABLE webhooks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  url        text NOT NULL,
  secret     text NOT NULL,
  events     text[] NOT NULL DEFAULT '{*}',
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            bigserial PRIMARY KEY,
  webhook_id    uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts      int NOT NULL DEFAULT 0,
  response_code int,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries(webhook_id, id DESC);

CREATE TABLE holidays (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day  date NOT NULL UNIQUE,
  name text NOT NULL
);

-- Feriados nacionais fixos de 2026–2027 (os móveis e municipais são cadastrados no painel)
INSERT INTO holidays (day, name) VALUES
 ('2026-11-02','Finados'), ('2026-11-15','Proclamação da República'), ('2026-11-20','Dia da Consciência Negra'), ('2026-12-25','Natal'),
 ('2027-01-01','Confraternização Universal'), ('2027-04-21','Tiradentes'), ('2027-05-01','Dia do Trabalho'),
 ('2027-09-07','Independência do Brasil'), ('2027-10-12','Nossa Senhora Aparecida'), ('2027-11-02','Finados'),
 ('2027-11-15','Proclamação da República'), ('2027-11-20','Dia da Consciência Negra'), ('2027-12-25','Natal')
ON CONFLICT (day) DO NOTHING;

CREATE INDEX conversations_followup_idx ON conversations(status, last_outbound_at) WHERE status <> 'closed';

INSERT INTO settings (key, value) VALUES
 ('followups', '{"enabled":true,"onlyBusinessHours":true,"hoursSectorSlug":"sdr","applyTo":"automation","attempts":[{"afterHours":24,"message":"Oi, {{nome}}! Passando para saber se ficou alguma dúvida sobre a Nimber. Posso te ajudar com algo?","useAi":false},{"afterHours":72,"message":"{{nome}}, sigo por aqui caso queira retomar a conversa sobre investimentos com a Nimber. É só responder esta mensagem.","useAi":false}],"autoCloseAfterHours":48,"optOutKeywords":["parar","sair","pare","nao quero mais","não quero mais","remover","descadastrar"]}'),
 ('notifications', '{"slackWebhookUrl":"","notifyConnectionDown":true,"notifyComplianceBlock":true}')
ON CONFLICT (key) DO NOTHING;

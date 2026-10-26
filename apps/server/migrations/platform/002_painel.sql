-- =====================================================================
-- softIA · schema plataforma · 002 · Painel do fornecedor
--
-- A equipe do fornecedor usa as MESMAS tabelas de acesso que cada cliente tem (users, user_sessions,
-- audit_log, settings), só que no schema plataforma. Assim o login com 2FA, as sessões e a auditoria
-- do Atende funcionam no painel sem código novo. Papéis: admin (super admin), implantador, suporte.
-- =====================================================================

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  email                text NOT NULL,
  password_hash        text NOT NULL,
  role                 text NOT NULL DEFAULT 'suporte' CHECK (role IN ('admin','implantador','suporte')),
  permissions          jsonb NOT NULL DEFAULT '{}'::jsonb,
  active               boolean NOT NULL DEFAULT true,
  totp_secret_enc      text,
  totp_enabled         boolean NOT NULL DEFAULT false,
  recovery_codes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  failed_logins        int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  presence             text NOT NULL DEFAULT 'offline' CHECK (presence IN ('online','away','offline')),
  max_concurrent       int NOT NULL DEFAULT 25,
  signature            text,
  color                text NOT NULL DEFAULT '#99C1E4',
  last_login_at        timestamptz,
  last_seen_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE user_sessions (
  id           text PRIMARY KEY,            -- sha256 do token (o token em si nunca é gravado)
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_pending  boolean NOT NULL DEFAULT false,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id);
-- mesmas colunas do schema do cliente (o código de sessão é o mesmo); na plataforma ficam vazias
ALTER TABLE user_sessions ADD COLUMN impersonated_by uuid, ADD COLUMN impersonated_by_name text, ADD COLUMN impersonation_reason text;

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
CREATE INDEX audit_log_action_idx  ON audit_log(action);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
-- 2FA obrigatório para toda a equipe do fornecedor
INSERT INTO settings (key, value) VALUES
 ('org',      '{"name":"Painel do fornecedor"}'),
 ('security', '{"require2faAdmins":true,"require2faAll":true,"sessionHours":12,"passwordMinLength":12}');

-- O código de sessão faz LEFT JOIN em sector_members; na plataforma ela existe e fica sempre vazia.
CREATE TABLE sector_members (
  sector_id uuid NOT NULL,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (sector_id, user_id)
);

-- ------------------------------------------------------------ IA da plataforma (chaves do fornecedor)
CREATE TABLE ai_providers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('anthropic','openai','gemini','openai_compatible','mock')),
  api_key_enc text,
  base_url    text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_task_models (
  task                 text PRIMARY KEY CHECK (task IN ('triage','agent','guard','summary','transcription','embedding')),
  provider_id          uuid REFERENCES ai_providers(id) ON DELETE SET NULL,
  model                text,
  fallback_provider_id uuid REFERENCES ai_providers(id) ON DELETE SET NULL,
  fallback_model       text,
  temperature          numeric NOT NULL DEFAULT 0.3,
  max_tokens           int NOT NULL DEFAULT 1024,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ai_providers (name, kind) VALUES ('Simulado (sem custo)', 'mock');
INSERT INTO ai_task_models (task, provider_id, model, temperature, max_tokens)
SELECT t.task, p.id, 'simulado', t.temp, t.mx
  FROM ai_providers p,
       (VALUES ('triage',0.0,400),('agent',0.4,900),('guard',0.0,300),('summary',0.2,600),('transcription',0.0,0),('embedding',0.0,0)) AS t(task,temp,mx)
 WHERE p.kind='mock';

-- Consumo de IA de todos os clientes (franquia e tela do fornecedor). Cada cliente também guarda o seu.
CREATE TABLE ai_usage (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,
  task            text NOT NULL,
  provider_kind   text,
  model           text,
  conversation_id uuid,
  input_tokens    int,
  output_tokens   int,
  latency_ms      int,
  ok              boolean NOT NULL,
  fallback_used   boolean NOT NULL DEFAULT false,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_created_idx ON ai_usage(created_at DESC);
CREATE INDEX ai_usage_tenant_idx  ON ai_usage(tenant_id, created_at);

-- ------------------------------------------------------------ módulos ligados por cliente
CREATE TABLE tenant_modules (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module      text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module)
);

-- ------------------------------------------------------------ marca (logo) de cada cliente
CREATE TABLE brand_assets (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('logo')),
  mime        text NOT NULL,
  data        bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);

-- ------------------------------------------------------------ "entrar como cliente" (token de uso único, 60 s)
CREATE TABLE impersonation_tokens (
  id               text PRIMARY KEY,               -- sha256 do token
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           text,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

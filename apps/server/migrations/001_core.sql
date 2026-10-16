-- =====================================================================
-- Nimber Atende · 001 · Núcleo: acesso, setores, WhatsApp, atendimento
-- =====================================================================

-- Gera UUID sem depender de extensão (gen_random_uuid é nativo no PG13+)

-- ------------------------------------------------------------ fila de tarefas
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  queue         text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  run_at        timestamptz NOT NULL DEFAULT now(),
  status        text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts      int         NOT NULL DEFAULT 0,
  max_attempts  int         NOT NULL DEFAULT 5,
  singleton_key text,
  group_key     text,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE UNIQUE INDEX jobs_singleton_uq ON jobs(queue, singleton_key) WHERE status = 'queued' AND singleton_key IS NOT NULL;
CREATE INDEX jobs_ready_idx   ON jobs(queue, run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs(group_key) WHERE status = 'running';

-- ------------------------------------------------------------ configurações gerais
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- ------------------------------------------------------------ usuários e sessões
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  email                text NOT NULL,
  password_hash        text NOT NULL,
  role                 text NOT NULL DEFAULT 'agent' CHECK (role IN ('admin','supervisor','agent')),
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

-- ------------------------------------------------------------ setores
CREATE TABLE sectors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  slug                  text NOT NULL UNIQUE,
  description           text,
  color                 text NOT NULL DEFAULT '#99C1E4',
  distribution          text NOT NULL DEFAULT 'round_robin' CHECK (distribution IN ('round_robin','least_busy','pull')),
  hours                 jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"1":[["09:00","18:00"]], ... } (0=domingo)
  timezone              text NOT NULL DEFAULT 'America/Sao_Paulo',
  offhours_message      text,
  hours_enabled         boolean NOT NULL DEFAULT true,
  active                boolean NOT NULL DEFAULT true,
  sort                  int NOT NULL DEFAULT 0,
  last_assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sector_members (
  sector_id uuid NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (sector_id, user_id)
);

-- ------------------------------------------------------------ conexões WhatsApp
CREATE TABLE connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'disconnected'
                     CHECK (status IN ('disconnected','connecting','qr','connected','logged_out','error')),
  phone              text,
  me_jid             text,
  push_name          text,
  default_sector_id  uuid REFERENCES sectors(id) ON DELETE SET NULL,
  allowed_sector_ids uuid[] NOT NULL DEFAULT '{}',
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_connected_at  timestamptz,
  last_error         text,
  color              text NOT NULL DEFAULT '#FE5A51',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Sessão do WhatsApp (equivalente ao useMultiFileAuthState, mas no banco)
CREATE TABLE wa_auth_keys (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  category      text NOT NULL,
  key_id        text NOT NULL,
  value         jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, category, key_id)
);

-- Mapa LID → telefone (o WhatsApp passou a identificar contatos por LID)
CREATE TABLE lid_map (
  lid        text PRIMARY KEY,
  pn         text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ contatos
CREATE TABLE contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone               text,            -- só dígitos, com DDI (ex.: 5541999998888)
  lid                 text,
  name                text,
  push_name           text,
  email               text,
  notes               text,
  custom              jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_customer         boolean NOT NULL DEFAULT false,
  opted_out           boolean NOT NULL DEFAULT false,
  lead_status         text NOT NULL DEFAULT 'novo'
                      CHECK (lead_status IN ('novo','em_qualificacao','qualificado','desqualificado','cliente')),
  lead_profile        jsonb NOT NULL DEFAULT '{}'::jsonb,
  score               int,
  score_breakdown     jsonb NOT NULL DEFAULT '[]'::jsonb,
  origin              text,
  last_interaction_at timestamptz,
  anonymized_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_phone_uq ON contacts(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX contacts_lid_uq   ON contacts(lid)   WHERE lid IS NOT NULL;
CREATE INDEX contacts_name_idx ON contacts (lower(coalesce(name, push_name, '')));

CREATE TABLE tags (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name  text NOT NULL UNIQUE,
  color text NOT NULL DEFAULT '#99C1E4'
);
CREATE TABLE contact_tags (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

-- ------------------------------------------------------------ conversas
CREATE TABLE conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id        uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'automation'
                       CHECK (status IN ('automation','queued','open','closed')),
  sector_id            uuid REFERENCES sectors(id) ON DELETE SET NULL,
  assignee_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  ai_paused            boolean NOT NULL DEFAULT false,
  handoff_reason       text,
  priority             int NOT NULL DEFAULT 0,
  unread_count         int NOT NULL DEFAULT 0,
  context              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- variáveis do fluxo / IA
  handoff_card         jsonb,                                -- resumo gerado na transferência
  last_message_at      timestamptz,
  last_message_preview text,
  last_inbound_at      timestamptz,
  last_outbound_at     timestamptz,
  first_response_at    timestamptz,
  queued_at            timestamptz,
  assigned_at          timestamptz,
  closed_at            timestamptz,
  closed_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  close_reason         text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- Só pode existir uma conversa aberta por contato em cada número
CREATE UNIQUE INDEX conversations_open_uq ON conversations(connection_id, contact_id) WHERE status <> 'closed';
CREATE INDEX conversations_inbox_idx  ON conversations(status, sector_id, last_message_at DESC);
CREATE INDEX conversations_assignee_idx ON conversations(assignee_id) WHERE status = 'open';
CREATE INDEX conversations_contact_idx ON conversations(contact_id, created_at DESC);

CREATE TABLE media_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mime       text NOT NULL,
  filename   text,
  size       int NOT NULL,
  sha256     text,
  data       bytea,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  connection_id     uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  wa_id             text,
  direction         text NOT NULL CHECK (direction IN ('in','out','internal')),
  sender_type       text NOT NULL CHECK (sender_type IN ('contact','agent','ai','flow','system','phone')),
  sender_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  kind              text NOT NULL DEFAULT 'text',
  body              text,
  transcript        text,
  media_id          uuid REFERENCES media_files(id) ON DELETE SET NULL,
  quoted_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('queued','sending','sent','delivered','read','failed','blocked','received')),
  error             text,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_wa_uq ON messages(connection_id, wa_id) WHERE wa_id IS NOT NULL;
CREATE INDEX messages_conv_idx ON messages(conversation_id, created_at);

CREATE TABLE conversation_events (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  type            text NOT NULL,
  actor_type      text NOT NULL DEFAULT 'system',
  actor_id        uuid,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_events_conv_idx ON conversation_events(conversation_id, created_at);
CREATE INDEX conversation_events_type_idx ON conversation_events(type, created_at);

CREATE TABLE quick_replies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcut   text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  sector_id  uuid REFERENCES sectors(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quick_replies_shortcut_uq ON quick_replies (lower(shortcut), coalesce(sector_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ------------------------------------------------------------ dados iniciais
INSERT INTO sectors (name, slug, description, color, sort, offhours_message, hours) VALUES
 ('SDR', 'sdr', 'Primeiro contato e qualificação de leads', '#99C1E4', 1,
  'Olá! Nosso time comercial atende de segunda a sexta, das 9h às 18h. Sua mensagem foi registrada e um especialista vai continuar seu atendimento no próximo horário útil.',
  '{"1":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","18:00"]]}'),
 ('Closer', 'closer', 'Leads qualificados e fechamento', '#FE5A51', 2,
  'Olá! Nosso time comercial atende de segunda a sexta, das 9h às 18h. Um especialista vai falar com você no próximo horário útil.',
  '{"1":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","18:00"]]}'),
 ('Suporte', 'suporte', 'Dúvidas de quem já investe: acesso, rendimentos, resgates', '#7FB685', 3,
  'Olá! O suporte ao investidor atende de segunda a sexta, das 9h às 18h. Registramos sua mensagem e retornaremos no próximo horário útil.',
  '{"1":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","18:00"]]}'),
 ('Jurídico', 'juridico', 'Assuntos jurídicos e reclamações formais', '#C9A227', 4,
  'Olá! Registramos sua mensagem. Nosso time retornará no próximo horário útil.',
  '{"1":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","18:00"]]}');
UPDATE sectors SET active = false WHERE slug = 'juridico';

INSERT INTO settings (key, value) VALUES
 ('org',            '{"name":"Nimber","timezone":"America/Sao_Paulo"}'),
 ('security',       '{"require2faAdmins":true,"require2faAll":false,"sessionHours":12,"passwordMinLength":10}'),
 ('pacing',         '{"typingCharsPerSecond":18,"typingMinMs":900,"typingMaxMs":6000,"minGapMs":1200,"jitterMs":900,"perMinuteLimit":20}'),
 ('retention',      '{"enabled":false,"anonymizeClosedAfterDays":730,"deleteMediaAfterDays":365}'),
 ('inbox',          '{"debounceMs":4500,"autoCloseHours":72,"reopenWindowHours":24}');

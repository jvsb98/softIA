-- =====================================================================
-- softIA · schema do cliente · 002 · Inteligência artificial
-- =====================================================================

CREATE TABLE ai_providers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('anthropic','openai','gemini','openai_compatible','mock')),
  api_key_enc text,
  base_url    text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Modelo por tarefa, com reserva automático
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

CREATE TABLE ai_usage (
  id              bigserial PRIMARY KEY,
  task            text NOT NULL,
  provider_kind   text,
  model           text,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  input_tokens    int,
  output_tokens   int,
  latency_ms      int,
  ok              boolean NOT NULL,
  fallback_used   boolean NOT NULL DEFAULT false,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_created_idx ON ai_usage(created_at DESC);

-- Agentes de IA (o padrão atende quando não há fluxo; fluxos podem usar outros)
CREATE TABLE ai_agents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  persona               text NOT NULL DEFAULT '',
  objective             text NOT NULL DEFAULT '',
  instructions          text NOT NULL DEFAULT '',
  greeting              text,
  kb_enabled            boolean NOT NULL DEFAULT true,
  qualification_enabled boolean NOT NULL DEFAULT true,
  allowed_query_ids     uuid[] NOT NULL DEFAULT '{}',
  max_turns             int NOT NULL DEFAULT 14,
  is_default            boolean NOT NULL DEFAULT false,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ base de conhecimento
CREATE TABLE kb_documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  source     text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','text','site')),
  url        text,
  mime       text,
  filename   text,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','error')),
  error      text,
  chars      int NOT NULL DEFAULT 0,
  chunks     int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  raw_text   text,
  refresh_days int,
  last_fetched_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kb_chunks (
  id              bigserial PRIMARY KEY,
  document_id     uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  idx             int NOT NULL,
  heading         text,
  content         text NOT NULL,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', na_norm(coalesce(heading,'') || ' ' || content))) STORED,
  embedding_model text
);
CREATE INDEX kb_chunks_tsv_idx ON kb_chunks USING gin(tsv);
CREATE INDEX kb_chunks_doc_idx ON kb_chunks(document_id, idx);

CREATE TABLE faq_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question   text NOT NULL,
  answer     text NOT NULL,
  keywords   text NOT NULL DEFAULT '',
  active     boolean NOT NULL DEFAULT true,
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', na_norm(question || ' ' || keywords || ' ' || answer))) STORED,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX faq_entries_tsv_idx ON faq_entries USING gin(tsv);

-- ------------------------------------------------------------ qualificação híbrida
-- A IA extrai o valor de cada critério; a pontuação vem destas regras (não da IA).
CREATE TABLE qualification_criteria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  label       text NOT NULL,
  question    text NOT NULL,            -- como a IA pode perguntar, de forma natural
  description text NOT NULL DEFAULT '', -- orientação de extração para a IA
  type        text NOT NULL CHECK (type IN ('choice','number','boolean','text')),
  options     jsonb NOT NULL DEFAULT '[]'::jsonb, -- choice: [{value,label,points}] · number: [{min,max,points}] · boolean: {"true":n,"false":n}
  weight      numeric NOT NULL DEFAULT 1,
  required    boolean NOT NULL DEFAULT true,
  disqualify_values jsonb NOT NULL DEFAULT '[]'::jsonb, -- valores que desqualificam de imediato
  sort        int NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true
);

-- ------------------------------------------------------------ dados iniciais
INSERT INTO ai_providers (name, kind) VALUES ('Simulado (sem custo)', 'mock');

INSERT INTO ai_task_models (task, provider_id, model, temperature, max_tokens)
SELECT t.task, p.id, 'simulado', t.temp, t.mx
  FROM ai_providers p,
       (VALUES ('triage',0.0,400),('agent',0.4,900),('guard',0.0,300),('summary',0.2,600),('transcription',0.0,0),('embedding',0.0,0)) AS t(task,temp,mx)
 WHERE p.kind='mock';

INSERT INTO ai_agents (name, persona, objective, instructions, greeting, is_default) VALUES (
  'Assistente virtual',
  'Você é o assistente virtual da empresa no WhatsApp. Fala português do Brasil, com tom cordial, claro e profissional, sem gírias e sem exageros comerciais. Mensagens curtas, como numa conversa de WhatsApp: no máximo 3 parágrafos curtos e uma pergunta por vez.',
  'Tirar dúvidas usando somente a base de conhecimento, entender o que o contato precisa e encaminhar para uma pessoa do time quando for o momento.',
  E'- Apresente-se como assistente virtual na primeira mensagem.\n- Responda dúvidas com base apenas no CONTEXTO DA BASE DE CONHECIMENTO. Se a resposta não estiver lá, diga que vai confirmar com o time e transfira.\n- Faça uma pergunta por vez, sem parecer um formulário.\n- Nunca peça senha, código de verificação ou dados bancários.',
  NULL,
  true
);

-- Critérios de qualificação vêm do modelo de segmento; nenhum por padrão.

INSERT INTO settings (key, value) VALUES
 ('ai',            '{"enabled":true,"historyMessages":24}'),
 ('qualification', '{"enabled":false,"threshold":22,"targetSectorSlug":"comercial","disqualifyBelow":null}'),
 ('handoff',       '{"explicitRequest":true,"qualified":true,"noAnswer":true,"sensitive":true,"frustration":true,"failures":true,"failureLimit":2,"existingCustomer":true,"supportSectorSlug":"suporte","legalSectorSlug":"suporte"}'),
 ('compliance',    '{"guardEnabled":false,"prefilterEnabled":false,"appendDisclaimer":false,"disclaimer":"","disclaimerTriggers":[]}')
ON CONFLICT (key) DO NOTHING;

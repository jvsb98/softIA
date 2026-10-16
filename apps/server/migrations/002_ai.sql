-- =====================================================================
-- Nimber Atende · 002 · Inteligência artificial
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
  'Assistente Nimber',
  'Você é o assistente virtual da Nimber, plataforma brasileira de tokenização de ativos imobiliários (RWA). Fala português do Brasil, com tom cordial, claro e profissional — sem gírias e sem exageros comerciais. Mensagens curtas, como numa conversa de WhatsApp: no máximo 3 parágrafos curtos e uma pergunta por vez.',
  'Tirar dúvidas sobre a Nimber e sobre investimento em ativos tokenizados usando somente a base de conhecimento, entender o interesse do contato e qualificar o lead conforme os critérios, transferindo para um especialista humano quando for o momento.',
  E'- Apresente-se como assistente virtual da Nimber na primeira mensagem.\n- Responda dúvidas com base apenas no CONTEXTO DA BASE DE CONHECIMENTO. Se a resposta não estiver lá, diga que vai confirmar com um especialista e transfira.\n- Durante a conversa, colete naturalmente os critérios de qualificação ainda não preenchidos (uma pergunta por vez, sem parecer um formulário).\n- Use a ferramenta registrar_criterios sempre que o contato informar algo que responda a um critério.\n- Se o contato já for investidor e o assunto for a conta dele (acesso, extrato, rendimentos, resgate), transfira para o Suporte.\n- Nunca peça senha, código de verificação ou dados bancários.',
  NULL,
  true
);

INSERT INTO qualification_criteria (key, label, question, description, type, options, weight, sort) VALUES
 ('experiencia', 'Experiência com investimentos', 'Você já investe hoje? Em quê, por exemplo renda fixa, fundos ou imóveis?',
  'Classifique a experiência declarada do contato com investimentos.', 'choice',
  '[{"value":"nenhuma","label":"Ainda não investe","points":2},{"value":"renda_fixa","label":"Renda fixa / poupança","points":5},{"value":"fundos_acoes","label":"Fundos, ações ou FIIs","points":8},{"value":"imoveis","label":"Já investe em imóveis","points":10}]', 1, 1),
 ('valor', 'Valor que pretende investir (R$)', 'Quanto você pensa em investir nesse primeiro momento, aproximadamente?',
  'Valor em reais que o contato pretende investir. Converta "50 mil" em 50000.', 'number',
  '[{"min":0,"max":4999,"points":2},{"min":5000,"max":29999,"points":6},{"min":30000,"max":99999,"points":10},{"min":100000,"max":null,"points":14}]', 1, 2),
 ('prazo', 'Quando pretende investir', 'E você pensa em investir quando: agora, nos próximos meses ou ainda está pesquisando?',
  'Horizonte de decisão do contato.', 'choice',
  '[{"value":"agora","label":"Agora / este mês","points":8},{"value":"meses","label":"Próximos 3 meses","points":5},{"value":"pesquisando","label":"Só pesquisando","points":1}]', 1, 3);

INSERT INTO settings (key, value) VALUES
 ('ai',            '{"enabled":true,"historyMessages":24}'),
 ('qualification', '{"enabled":true,"threshold":22,"targetSectorSlug":"closer","disqualifyBelow":null}'),
 ('handoff',       '{"explicitRequest":true,"qualified":true,"noAnswer":true,"sensitive":true,"frustration":true,"failures":true,"failureLimit":2,"existingCustomer":true,"supportSectorSlug":"suporte","legalSectorSlug":"juridico"}'),
 ('compliance',    '{"guardEnabled":true,"appendDisclaimer":true,"disclaimer":"As informações compartilhadas aqui têm caráter exclusivamente informativo e não constituem recomendação de investimento. Investimentos em ativos tokenizados envolvem riscos, inclusive de perda do capital investido, e rentabilidade passada ou projetada não é garantia de resultados futuros. Antes de investir, leia os documentos da oferta disponíveis na plataforma Nimber.","disclaimerTriggers":["rentabilidade","retorno","rendimento","valoriza","lucro","tir","yield","dividend","% ao ano","% a.a"]}')
ON CONFLICT (key) DO NOTHING;

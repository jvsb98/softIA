# Modelo de dados

Referência das tabelas do PostgreSQL do Nimber Atende, gerada a partir do banco após todas as migrações (`apps/server/migrations`).

Convenções: chaves primárias `uuid` (exceto tabelas de registro e a fila de tarefas, com `bigint` sequencial, e `user_sessions`, cujo id é o hash do token), datas em `timestamptz` (UTC no banco, exibidas em America/Sao_Paulo), segredos sempre cifrados com AES-256-GCM pela chave mestra (`master.key`).

Extensões opcionais: `vector` (pgvector — busca semântica na base de conhecimento), `unaccent` e `pg_trgm` (busca sem acento e por semelhança). Sem elas o sistema funciona, com busca só por palavras.


## Acesso e auditoria

Migração `001_*.sql`.


### `users`

Pessoas que usam o painel: papel (admin, supervisor, atendente), permissões extras, 2FA (segredo cifrado) e bloqueio por tentativas.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `email` | text | sim |
| `password_hash` | text | sim |
| `role` | text | sim |
| `permissions` | jsonb | sim |
| `active` | boolean | sim |
| `totp_secret_enc` | text |  |
| `totp_enabled` | boolean | sim |
| `recovery_codes` | jsonb | sim |
| `failed_logins` | integer | sim |
| `locked_until` | timestamp with time zone |  |
| `must_change_password` | boolean | sim |
| `presence` | text | sim |
| `max_concurrent` | integer | sim |
| `signature` | text |  |
| `color` | text | sim |
| `last_login_at` | timestamp with time zone |  |
| `last_seen_at` | timestamp with time zone |  |
| `created_at` | timestamp with time zone | sim |
| `updated_at` | timestamp with time zone | sim |

### `user_sessions`

Sessões de login. Guarda só o hash SHA-256 do token do cookie; expira por inatividade.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | text | sim |
| `user_id` | uuid | sim |
| `mfa_pending` | boolean | sim |
| `ip` | text |  |
| `user_agent` | text |  |
| `created_at` | timestamp with time zone | sim |
| `last_seen_at` | timestamp with time zone | sim |
| `expires_at` | timestamp with time zone | sim |
| `revoked_at` | timestamp with time zone |  |

### `audit_log`

Quem fez o quê, quando e de qual IP (configurações, usuários, exportações, anonimizações).

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | bigint | sim |
| `user_id` | uuid |  |
| `action` | text | sim |
| `entity` | text |  |
| `entity_id` | text |  |
| `data` | jsonb | sim |
| `ip` | text |  |
| `created_at` | timestamp with time zone | sim |

### `settings`

Configurações gerais em JSON por chave (org, segurança, ritmo de envio, IA, follow-ups, alertas…).

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `key` | text | sim |
| `value` | jsonb | sim |
| `updated_at` | timestamp with time zone | sim |
| `updated_by` | uuid |  |

### `schema_migrations`

Controle das migrações já aplicadas.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `name` | text | sim |
| `applied_at` | timestamp with time zone | sim |

### `jobs`

Fila de tarefas em segundo plano (envio de mensagens, IA, indexação, webhooks, follow-ups).

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | bigint | sim |
| `queue` | text | sim |
| `payload` | jsonb | sim |
| `run_at` | timestamp with time zone | sim |
| `status` | text | sim |
| `attempts` | integer | sim |
| `max_attempts` | integer | sim |
| `singleton_key` | text |  |
| `group_key` | text |  |
| `locked_at` | timestamp with time zone |  |
| `locked_by` | text |  |
| `last_error` | text |  |
| `created_at` | timestamp with time zone | sim |
| `finished_at` | timestamp with time zone |  |

## Setores e WhatsApp

Migração `001_*.sql`.


### `sectors`

Setores (SDR, Closer, Suporte, Jurídico): horário de atendimento, mensagem fora do horário e regra de distribuição.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `slug` | text | sim |
| `description` | text |  |
| `color` | text | sim |
| `distribution` | text | sim |
| `hours` | jsonb | sim |
| `timezone` | text | sim |
| `offhours_message` | text |  |
| `hours_enabled` | boolean | sim |
| `active` | boolean | sim |
| `sort` | integer | sim |
| `last_assigned_user_id` | uuid |  |
| `created_at` | timestamp with time zone | sim |

### `sector_members`

Quem atende em cada setor.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `sector_id` | uuid | sim |
| `user_id` | uuid | sim |

### `connections`

Números de WhatsApp conectados por QR Code, com setor padrão e fluxo de entrada.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `enabled` | boolean | sim |
| `status` | text | sim |
| `phone` | text |  |
| `me_jid` | text |  |
| `push_name` | text |  |
| `default_sector_id` | uuid |  |
| `allowed_sector_ids` | _uuid | sim |
| `settings` | jsonb | sim |
| `last_connected_at` | timestamp with time zone |  |
| `last_error` | text |  |
| `color` | text | sim |
| `created_at` | timestamp with time zone | sim |
| `entry_flow_id` | uuid |  |

### `wa_auth_keys`

Chaves da sessão do WhatsApp (equivalem ao "aparelho conectado"). Ficam no banco para o serviço reconectar sozinho.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `connection_id` | uuid | sim |
| `category` | text | sim |
| `key_id` | text | sim |
| `value` | jsonb | sim |
| `updated_at` | timestamp with time zone | sim |

### `lid_map`

Mapa entre o identificador interno do WhatsApp (LID) e o telefone.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `lid` | text | sim |
| `pn` | text | sim |
| `updated_at` | timestamp with time zone | sim |

### `holidays`

Feriados: todos os setores ficam fora do horário.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `day` | date | sim |
| `name` | text | sim |

## Atendimento

Migração `001_*.sql`.


### `contacts`

Contatos (leads e clientes): telefone, nome, status do lead, score, campos personalizados, opt-out e anonimização.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `phone` | text |  |
| `lid` | text |  |
| `name` | text |  |
| `push_name` | text |  |
| `email` | text |  |
| `notes` | text |  |
| `custom` | jsonb | sim |
| `is_customer` | boolean | sim |
| `opted_out` | boolean | sim |
| `lead_status` | text | sim |
| `lead_profile` | jsonb | sim |
| `score` | integer |  |
| `score_breakdown` | jsonb | sim |
| `origin` | text |  |
| `last_interaction_at` | timestamp with time zone |  |
| `anonymized_at` | timestamp with time zone |  |
| `created_at` | timestamp with time zone | sim |
| `updated_at` | timestamp with time zone | sim |

### `tags`

Etiquetas.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `color` | text | sim |

### `contact_tags`

Etiquetas aplicadas a cada contato.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `contact_id` | uuid | sim |
| `tag_id` | uuid | sim |

### `conversations`

Conversas: conexão, contato, setor, atendente, status (automação, fila, aberta, encerrada), prioridade e contexto da IA/fluxo.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `connection_id` | uuid | sim |
| `contact_id` | uuid | sim |
| `status` | text | sim |
| `sector_id` | uuid |  |
| `assignee_id` | uuid |  |
| `ai_paused` | boolean | sim |
| `handoff_reason` | text |  |
| `priority` | integer | sim |
| `unread_count` | integer | sim |
| `context` | jsonb | sim |
| `handoff_card` | jsonb |  |
| `last_message_at` | timestamp with time zone |  |
| `last_message_preview` | text |  |
| `last_inbound_at` | timestamp with time zone |  |
| `last_outbound_at` | timestamp with time zone |  |
| `first_response_at` | timestamp with time zone |  |
| `queued_at` | timestamp with time zone |  |
| `assigned_at` | timestamp with time zone |  |
| `closed_at` | timestamp with time zone |  |
| `closed_by` | uuid |  |
| `close_reason` | text |  |
| `created_at` | timestamp with time zone | sim |

### `messages`

Mensagens recebidas, enviadas e notas internas, com status de entrega e quem enviou (contato, atendente, IA, fluxo, sistema).

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `conversation_id` | uuid | sim |
| `connection_id` | uuid | sim |
| `wa_id` | text |  |
| `direction` | text | sim |
| `sender_type` | text | sim |
| `sender_user_id` | uuid |  |
| `kind` | text | sim |
| `body` | text |  |
| `transcript` | text |  |
| `media_id` | uuid |  |
| `quoted_message_id` | uuid |  |
| `status` | text | sim |
| `error` | text |  |
| `meta` | jsonb | sim |
| `created_at` | timestamp with time zone | sim |

### `media_files`

Arquivos de mídia (áudio, imagem, documento) ligados às mensagens.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `mime` | text | sim |
| `filename` | text |  |
| `size` | integer | sim |
| `sha256` | text |  |
| `data` | bytea |  |
| `deleted_at` | timestamp with time zone |  |
| `created_at` | timestamp with time zone | sim |

### `conversation_events`

Linha do tempo: transferências, atribuições, qualificação, bloqueios de compliance, follow-ups.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | bigint | sim |
| `conversation_id` | uuid | sim |
| `type` | text | sim |
| `actor_type` | text | sim |
| `actor_id` | uuid |  |
| `data` | jsonb | sim |
| `created_at` | timestamp with time zone | sim |

### `quick_replies`

Respostas rápidas (atalho com "/").

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `shortcut` | text | sim |
| `title` | text | sim |
| `body` | text | sim |
| `sector_id` | uuid |  |
| `created_by` | uuid |  |
| `created_at` | timestamp with time zone | sim |

## Inteligência artificial

Migração `002_*.sql`.


### `ai_providers`

Provedores de IA (Anthropic, OpenAI, Gemini, compatíveis, simulado). A chave de API fica cifrada com a chave mestra.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `kind` | text | sim |
| `api_key_enc` | text |  |
| `base_url` | text |  |
| `enabled` | boolean | sim |
| `created_at` | timestamp with time zone | sim |

### `ai_task_models`

Qual modelo atende cada tarefa (triagem, agente, guarda, resumo, transcrição, embeddings) e o modelo reserva.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `task` | text | sim |
| `provider_id` | uuid |  |
| `model` | text |  |
| `fallback_provider_id` | uuid |  |
| `fallback_model` | text |  |
| `temperature` | numeric | sim |
| `max_tokens` | integer | sim |
| `updated_at` | timestamp with time zone | sim |

### `ai_usage`

Consumo por chamada: tarefa, modelo, tokens, latência e erro, para custo e diagnóstico.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | bigint | sim |
| `task` | text | sim |
| `provider_kind` | text |  |
| `model` | text |  |
| `conversation_id` | uuid |  |
| `input_tokens` | integer |  |
| `output_tokens` | integer |  |
| `latency_ms` | integer |  |
| `ok` | boolean | sim |
| `fallback_used` | boolean | sim |
| `error` | text |  |
| `created_at` | timestamp with time zone | sim |

### `ai_agents`

Agentes de IA: persona, objetivo, instruções, uso da base de conhecimento, qualificação e consultas liberadas.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `persona` | text | sim |
| `objective` | text | sim |
| `instructions` | text | sim |
| `greeting` | text |  |
| `kb_enabled` | boolean | sim |
| `qualification_enabled` | boolean | sim |
| `allowed_query_ids` | _uuid | sim |
| `max_turns` | integer | sim |
| `is_default` | boolean | sim |
| `active` | boolean | sim |
| `created_at` | timestamp with time zone | sim |
| `updated_at` | timestamp with time zone | sim |

### `kb_documents`

Documentos da base de conhecimento (PDF, Word, texto, site).

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `title` | text | sim |
| `source` | text | sim |
| `url` | text |  |
| `mime` | text |  |
| `filename` | text |  |
| `status` | text | sim |
| `error` | text |  |
| `chars` | integer | sim |
| `chunks` | integer | sim |
| `active` | boolean | sim |
| `raw_text` | text |  |
| `refresh_days` | integer |  |
| `last_fetched_at` | timestamp with time zone |  |
| `created_by` | uuid |  |
| `created_at` | timestamp with time zone | sim |
| `updated_at` | timestamp with time zone | sim |

### `kb_chunks`

Trechos indexados dos documentos para busca por palavras e, com pgvector, por significado.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | bigint | sim |
| `document_id` | uuid | sim |
| `idx` | integer | sim |
| `heading` | text |  |
| `content` | text | sim |
| `tsv` | tsvector |  |
| `embedding_model` | text |  |
| `embedding` | vector |  |

### `faq_entries`

Perguntas frequentes editáveis, com prioridade sobre os documentos.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `question` | text | sim |
| `answer` | text | sim |
| `keywords` | text | sim |
| `active` | boolean | sim |
| `tsv` | tsvector |  |
| `created_by` | uuid |  |
| `updated_at` | timestamp with time zone | sim |

### `qualification_criteria`

Critérios de qualificação de lead e pontos de cada resposta.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `key` | text | sim |
| `label` | text | sim |
| `question` | text | sim |
| `description` | text | sim |
| `type` | text | sim |
| `options` | jsonb | sim |
| `weight` | numeric | sim |
| `required` | boolean | sim |
| `disqualify_values` | jsonb | sim |
| `sort` | integer | sim |
| `active` | boolean | sim |

## Fluxos

Migração `003_*.sql`.


### `flows`

Fluxos de atendimento (rascunho e versão publicada).

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `description` | text |  |
| `draft` | jsonb | sim |
| `draft_updated_at` | timestamp with time zone | sim |
| `draft_updated_by` | uuid |  |
| `published_version_id` | uuid |  |
| `archived` | boolean | sim |
| `created_by` | uuid |  |
| `created_at` | timestamp with time zone | sim |

### `flow_versions`

Histórico de versões publicadas (permite restaurar).

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `flow_id` | uuid | sim |
| `version` | integer | sim |
| `definition` | jsonb | sim |
| `note` | text |  |
| `published_by` | uuid |  |
| `published_at` | timestamp with time zone | sim |

### `flow_runs`

Execução de um fluxo numa conversa: nó atual, variáveis e espera.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `flow_id` | uuid | sim |
| `flow_version_id` | uuid | sim |
| `conversation_id` | uuid | sim |
| `status` | text | sim |
| `current_node_id` | text |  |
| `waiting_for` | text |  |
| `waiting_since` | timestamp with time zone |  |
| `wake_token` | text |  |
| `retries` | integer | sim |
| `vars` | jsonb | sim |
| `error` | text |  |
| `started_at` | timestamp with time zone | sim |
| `ended_at` | timestamp with time zone |  |

### `flow_run_steps`

Passos executados, para as métricas por nó.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | bigint | sim |
| `run_id` | uuid | sim |
| `flow_version_id` | uuid | sim |
| `node_id` | text | sim |
| `node_type` | text | sim |
| `handle_out` | text |  |
| `created_at` | timestamp with time zone | sim |

## Integrações

Migração `004_*.sql`.


### `external_databases`

Bancos externos (PostgreSQL, MySQL, SQL Server) consultados em modo somente leitura. Senha cifrada.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `kind` | text | sim |
| `host` | text | sim |
| `port` | integer | sim |
| `database` | text | sim |
| `username` | text | sim |
| `password_enc` | text |  |
| `ssl` | text | sim |
| `enabled` | boolean | sim |
| `created_at` | timestamp with time zone | sim |

### `saved_queries`

Consultas cadastradas (SQL com parâmetros), máscaras LGPD e exigência de verificação de identidade.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `database_id` | uuid | sim |
| `name` | text | sim |
| `label` | text | sim |
| `description` | text | sim |
| `sql` | text | sim |
| `params` | jsonb | sim |
| `output_fields` | _text | sim |
| `masks` | jsonb | sim |
| `max_rows` | integer | sim |
| `timeout_ms` | integer | sim |
| `requires_verification` | boolean | sim |
| `is_verification` | boolean | sim |
| `ai_enabled` | boolean | sim |
| `enabled` | boolean | sim |
| `created_by` | uuid |  |
| `created_at` | timestamp with time zone | sim |
| `updated_at` | timestamp with time zone | sim |

### `query_runs`

Auditoria de cada consulta executada (parâmetros mascarados, linhas, tempo, origem).

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | bigint | sim |
| `query_id` | uuid |  |
| `conversation_id` | uuid |  |
| `actor` | text | sim |
| `user_id` | uuid |  |
| `params_masked` | jsonb | sim |
| `rows` | integer |  |
| `ms` | integer |  |
| `ok` | boolean | sim |
| `error` | text |  |
| `created_at` | timestamp with time zone | sim |

### `webhooks`

Destinos de webhook (n8n, CRM) com eventos assinados por HMAC.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | uuid | sim |
| `name` | text | sim |
| `url` | text | sim |
| `secret` | text | sim |
| `events` | _text | sim |
| `enabled` | boolean | sim |
| `created_at` | timestamp with time zone | sim |

### `webhook_deliveries`

Entregas de webhook, tentativas e respostas.

| Coluna | Tipo | Obrigatória |
|---|---|---|
| `id` | bigint | sim |
| `webhook_id` | uuid | sim |
| `event` | text | sim |
| `payload` | jsonb | sim |
| `status` | text | sim |
| `attempts` | integer | sim |
| `response_code` | integer |  |
| `error` | text |  |
| `created_at` | timestamp with time zone | sim |
| `delivered_at` | timestamp with time zone |  |

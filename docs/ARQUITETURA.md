# Nimber Atende — Documento de Arquitetura (Fase 0)

> Versão 1.0 · outubro/2026 · Tecnologia Nimber
> Status: **aprovado para construção** (decisões registradas na seção 2)

---

## 1. Visão

O **Nimber Atende** é a central de atendimento própria da Nimber no WhatsApp. Ele substitui a dependência de SaaS (tipo RD Conversas) por um sistema instalado na nossa infraestrutura, com os dados no nosso PostgreSQL.

Num único painel, ele reúne:

- **Vários números de WhatsApp** conectados por QR Code ("Aparelhos conectados"), sem API da Meta;
- **Caixa de entrada multiatendente** com setores (SDR, Closer, Suporte e, depois, Jurídico), transferências, notas internas e respostas rápidas;
- **Agente de IA** que tira dúvidas sobre tokenização com base na nossa base de conhecimento, qualifica o lead e passa para um humano no momento certo;
- **Construtor visual de fluxos** (no estilo n8n), com simulador, versões e métricas por etapa;
- **Integrações**: consultas controladas a outras bases de dados, webhooks para n8n e CRM, e follow-ups automáticos.

O sistema não é um clone do RD Conversas: ele foi desenhado a partir de um **benchmark funcional**, com código 100% próprio.

---

## 2. Decisões registradas

| # | Tema | Decisão |
|---|------|---------|
| 1 | Núcleo de conexão | Baileys (protocolo do WhatsApp Web, sem navegador), reaproveitando o núcleo validado no Extrator de Integrantes: versão do WA Web consultada a cada conexão, patch do `companion_reg_refresh` e identidade fixa |
| 2 | Número | Números já existentes, usados também no celular pela equipe. Uma resposta enviada pelo celular pausa a IA na conversa |
| 3 | Servidor | Começa em servidor local (Windows) e vai para a DigitalOcean (Ubuntu + Docker) depois dos testes |
| 4 | Acesso | Navegador **e** app Windows (o mesmo front-end) |
| 5 | Banco | PostgreSQL dedicado, local nos testes e com cluster gerenciado próprio na DigitalOcean |
| 6 | Login | Login próprio com 2FA (TOTP), preparado para SSO Microsoft no futuro |
| 7 | Setores | SDR, Closer e Suporte; Jurídico previsto. Um atendente por setor, com suporte a vários |
| 8 | Números × setores | Configurável por conexão: fluxo de entrada e setores permitidos |
| 9 | Fora do horário | Mensagem fixa, sem IA (texto por conexão e setor) |
| 10 | Envio ativo | O atendente inicia conversas individuais. Follow-ups automáticos só para quem já interagiu. Sem campanhas em massa |
| 11 | Provedores de IA | Vários provedores, com modelo por tarefa e reserva automático |
| 12 | Base de conhecimento | Documentos, FAQ editável e consultas a outras bases de dados (somente leitura e auditadas) |
| 13 | Qualificação | Híbrida: a IA extrai os critérios e o score sai de regras configuráveis |
| 14 | Transferência e compliance | 7 gatilhos de transferência e 3 travas absolutas (rentabilidade, recomendação, orientação jurídica e tributária) |
| 15 | Quem monta fluxos | Negócio e tecnologia, com níveis de permissão e modelos prontos |
| 16 | Publicação | Rascunho e versão publicada, histórico com reversão, simulador, validação e métricas por nó |
| 17 | Construção | Pacotes `.zip` prontos para GitHub, com instruções explícitas |
| 18 | Fases | Fases 0 a 5, em sequência e sem gate de aprovação |

---

## 3. Visão geral da arquitetura

```
                ┌──────────────────────────── Servidor Nimber Atende ────────────────────────────┐
 Celular(es)    │                                                                                 │
 WhatsApp  ◀──▶ │  Gerenciador de Conexões ── Baileys (1 sessão por número, sessão no Postgres)   │
 (Aparelhos     │        │                                                                        │
  conectados)   │        ▼ mensagem recebida                                                      │
                │  Ingestão ─▶ Contato/Conversa ─▶ Fila de jobs (Postgres, SKIP LOCKED)           │
                │                                         │                                       │
                │        ┌────────────────────────────────┼──────────────────────────┐            │
                │        ▼                                ▼                          ▼            │
                │  Motor de Fluxos  ◀──────▶  Motor de IA (triagem, agente,    Roteamento de     │
                │  (versão publicada)        RAG, qualificação, guarda)       setor/atendente    │
                │        │                                │                          │            │
                │        └──────────────▶ Fila de Envio (ritmo humano, digitando…) ◀─┘            │
                │                                                                                 │
                │  API REST + WebSocket (Fastify + Socket.IO) ── serve o front-end React           │
                └───────────────▲───────────────────────────────▲─────────────────────────────────┘
                                │ HTTPS                         │ database.txt
                 Navegador / App Windows (Electron)       PostgreSQL dedicado
                 Atendentes · Supervisores · Admin        (dados, sessão WA, jobs, vetores)
```

### 3.1 Componentes

| Componente | Tecnologia | Responsabilidade |
|---|---|---|
| `apps/server` | Node.js 22, TypeScript, Fastify 5, Socket.IO, `pg` | API, tempo real, conexões WhatsApp, IA, fluxos e jobs |
| `apps/web` | React 19, Vite, Tailwind 4, TanStack Query, React Flow | Caixa de entrada, painel administrativo e construtor de fluxos |
| `apps/desktop` | Electron 44 | App Windows: aponta para o servidor, notificações nativas, bandeja e início automático |
| `deploy/windows` | Inno Setup + WinSW + Node portátil | Instalador do **servidor** como serviço do Windows |
| `deploy/docker` | Docker, Compose, Caddy | Produção na DigitalOcean com HTTPS automático |

### 3.2 Por que essas escolhas

- **Fila de jobs própria no Postgres** (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`). Evita Redis, que não tem versão nativa estável no Windows, e um serviço a mais para instalar. Também resolve a deduplicação e o *debounce* de mensagens em sequência.
- **Sessão do WhatsApp no banco**, não em arquivos. Sobrevive a reinstalação e a migração para a nuvem sem precisar ler o QR Code de novo.
- **Provedores de IA chamados por HTTP direto**, sem SDKs. Uma interface única com *tool calling* para Anthropic, OpenAI (e compatíveis) e Gemini, e menos dependências para atualizar.
- **pgvector opcional.** Se a extensão existir, a busca semântica é usada. Se não existir (comum em Postgres Windows recém-instalado), o sistema cai para busca textual em português (`tsvector` + `unaccent` + trigramas) sem parar de funcionar.
- **TOTP (2FA) implementado com `node:crypto`** seguindo o RFC 6238, sem biblioteca externa.

---

## 4. Ciclo de vida de uma mensagem recebida

1. O **Baileys** entrega `messages.upsert`. O gerenciador normaliza o JID: resolve LID para telefone usando o mapa de LIDs (lição do Extrator) e descarta grupos, status e newsletters.
2. A **ingestão** grava a mensagem de forma idempotente (índice único `connection_id + wa_message_id`), cria ou atualiza o contato e abre ou reabre a conversa.
3. Se a mensagem saiu **do próprio celular** (`fromMe` sem registro de envio pelo sistema), ela é registrada como "humano (celular)", a IA é pausada e o fluxo é interrompido.
4. Se a conversa está com **humano**, o atendente é notificado em tempo real e nada automático acontece.
5. Se a conversa está com **automação**, um job `conversation.process` é agendado com *debounce* de alguns segundos. Isso agrupa mensagens enviadas em sequência ("oi" / "tudo bem?" / "queria saber…").
6. O job decide:
   - **Fora do horário** do setor-alvo → envia a mensagem fixa e enfileira a conversa para o setor.
   - **Fluxo ativo** → o motor de fluxos avança a partir do nó em espera.
   - **Nó de agente IA** → triagem (gatilhos de transferência), RAG, extração de critérios e score, rascunho de resposta, **verificador de compliance** e envio.
7. O **envio** passa pela fila de saída: presença "digitando…" proporcional ao tamanho do texto, intervalo com variação aleatória e limite por conexão por minuto.
8. Tudo é transmitido em tempo real (Socket.IO) para os atendentes daquele setor.

---

## 5. Modelo de dados (resumo)

O detalhe completo está em `apps/server/migrations/`. Principais grupos:

| Grupo | Tabelas |
|---|---|
| Acesso | `users`, `user_sessions`, `audit_log` |
| Organização | `sectors`, `sector_members`, `business_hours` (no setor), `holidays`, `tags`, `quick_replies` |
| WhatsApp | `connections`, `wa_auth_keys`, `lid_map` |
| Atendimento | `contacts`, `conversations`, `messages`, `media_files`, `conversation_events`, `conversation_tags` |
| IA | `ai_providers`, `ai_task_models`, `ai_usage`, `kb_documents`, `kb_chunks`, `faq_entries`, `qualification_criteria` |
| Fluxos | `flows`, `flow_versions`, `flow_runs`, `flow_run_steps` |
| Integrações | `external_databases`, `saved_queries`, `query_runs`, `webhooks`, `webhook_deliveries` |
| Operação | `jobs`, `settings`, `followup_state` |

**Regras de negócio são dados**, não código: setores, horários, critérios de score, gatilhos, textos, limites e fluxos são editáveis no painel.

---

## 6. Inteligência artificial

### 6.1 Tarefas e modelos

| Tarefa | Uso | Sugestão padrão |
|---|---|---|
| `triage` | Intenção, sentimento, pedido de humano, assunto sensível, cliente existente | Modelo rápido (ex.: Claude Haiku) |
| `agent` | Conversa, dúvidas sobre tokenização, extração de critérios, chamada de consultas | Modelo capaz (ex.: Claude Sonnet) |
| `guard` | Verificador de compliance da resposta antes do envio | Modelo rápido |
| `summary` | Resumo da conversa na transferência e sugestão de resposta para o atendente | Modelo rápido |
| `transcription` | Transcrição de áudio | OpenAI (Whisper/gpt-4o-transcribe) ou Gemini |
| `embedding` | Vetores da base de conhecimento (opcional) | OpenAI `text-embedding-3-small` ou Gemini |

Cada tarefa tem um **provedor principal e um reserva**. Se o principal falhar (erro, *timeout* ou limite), o reserva é usado e o evento é registrado em `ai_usage`. Se nenhum responder, a conversa vai para um humano.

Há também um provedor **"Simulado"**, sem custo e sem rede. Ele permite testar fluxos e o simulador antes de cadastrar uma chave real.

### 6.2 Gatilhos de transferência para humano (todos ativos)

1. O lead pede explicitamente para falar com uma pessoa.
2. O score atinge o corte de qualificação (vai para o Closer).
3. A pergunta não tem resposta confiável na base de conhecimento.
4. Assunto sensível: resgate, saque, problema com investimento, reclamação, Procon, advogado (notifica o Jurídico quando o setor existir).
5. Irritação ou frustração detectada.
6. Duas falhas seguidas de entendimento.
7. O contato já é cliente e o assunto é a conta dele (vai para o Suporte).

Na transferência, o atendente recebe um **cartão de contexto** gerado pela IA: quem é o lead, o que quer, o score com o extrato, os pontos de atenção e uma sugestão de primeira resposta.

### 6.3 Travas de compliance (inegociáveis)

A IA **nunca**:

1. promete ou projeta rentabilidade além do publicado oficialmente na oferta;
2. faz recomendação personalizada de investimento;
3. dá orientação jurídica ou tributária.

São três camadas:

- **Instruções explícitas no prompt do agente.**
- **Pré-filtro determinístico** com expressões sobre promessa de retorno, "garantido", "sem risco", "recomendo que você invista" e similares.
- **Verificador por IA** (tarefa `guard`) que aprova ou bloqueia o rascunho.

Uma resposta bloqueada **não é enviada**: a conversa vai para um humano e o evento fica na auditoria (`compliance.blocked`).

### 6.4 Disclaimer proposto — *pendente de validação do compliance*

> "As informações compartilhadas aqui têm caráter exclusivamente informativo e não constituem recomendação de investimento. Investimentos em ativos tokenizados envolvem riscos, inclusive de perda do capital investido, e rentabilidade passada ou projetada não é garantia de resultados futuros. Antes de investir, leia os documentos da oferta disponíveis na plataforma Nimber."

O texto é editável em **Configurações → Compliance** e é anexado automaticamente quando a IA fala de ofertas, valores ou rentabilidade.

### 6.5 Mídias

- **Áudio:** transcrito; a IA responde.
- **Imagem e PDF:** guardados e encaminhados para um humano. A IA não lê documentos pessoais (LGPD: minimiza o dado enviado aos provedores).

---

## 7. Consultas a outras bases de dados

- **Conexões externas** (PostgreSQL, SQL Server e MySQL) com usuário **somente leitura** e senha criptografada (AES-256-GCM).
- **Consultas cadastradas:** SQL fixo com parâmetros nomeados (`:cpf`), nome, descrição para a IA, campos de saída permitidos, máscaras (CPF, e-mail, valores), limite de linhas e *timeout*.
- A IA escolhe **qual** consulta usar e preenche os parâmetros; **nunca escreve SQL**.
- Consultas marcadas como **"exige verificação"** só rodam depois que o contato passa pela verificação de identidade na conversa (CPF + e-mail conferidos por uma consulta de verificação).
- Toda execução é registrada (`query_runs`): conversa, parâmetros mascarados, linhas, tempo e quem disparou (IA, fluxo ou atendente).

---

## 8. Segurança e LGPD

| Tema | Implementação |
|---|---|
| Senhas | bcrypt (custo 12), política mínima e bloqueio após 5 tentativas por 15 minutos |
| 2FA | TOTP (RFC 6238) obrigatório para Admin e opcional para os demais (configurável); códigos de recuperação |
| Sessão | Token opaco em cookie `HttpOnly` + `SameSite=Strict`, armazenado como hash SHA-256, com expiração deslizante e revogação |
| CSRF | Cookie `SameSite=Strict` + verificação de `Origin` em métodos de escrita |
| Segredos | Chaves de IA e senhas de bancos externos com AES-256-GCM e chave-mestra em `config/master.key` |
| `database.txt` | No Windows, a senha é protegida com **DPAPI** na primeira execução (`PASSWORD=dpapi:...`) |
| Cabeçalhos | Helmet (CSP, HSTS atrás de proxy), *rate limit* global e reforçado no login |
| Auditoria | `audit_log` para login, mudanças de configuração, publicação de fluxos, consultas externas e bloqueios de compliance |
| Retenção | Política configurável: anonimiza conversas encerradas após N dias e remove mídias após M dias |
| Direitos do titular | Exportação e exclusão (anonimização) de um contato pelo painel |
| Opt-out | "parar", "sair" e "não quero mais" encerram os follow-ups e marcam o contato |

---

## 9. Proteção contra bloqueio do número

Como a conexão não é oficial, o sistema adota um **ritmo humano** por padrão:

- presença "digitando…" proporcional ao tamanho da mensagem (com teto);
- intervalo mínimo entre mensagens na mesma conversa, com variação aleatória;
- limite de mensagens por minuto por conexão, com fila;
- nenhum disparo em massa; o envio ativo é individual e feito por um humano;
- follow-ups só para quem já interagiu, com no máximo 2 tentativas, só no horário comercial e com *opt-out* respeitado;
- `markOnlineOnConnect: false` e sincronização de histórico desligada.

---

## 10. Implantação

| Ambiente | Como roda | Configuração |
|---|---|---|
| Testes (Windows) | Serviço "Nimber Atende Server" (WinSW) instalado pelo `NimberAtendeServer-Setup.exe` | `C:\ProgramData\NimberAtende\config\database.txt` |
| Produção (DigitalOcean) | Droplet Ubuntu + Docker Compose + Caddy (HTTPS) | `/opt/nimber-atende/config/database.txt` |
| Atendentes | Navegador ou `NimberAtende-Setup.exe` (app desktop) | Endereço do servidor na primeira abertura |

A **migração local → nuvem** é feita com `pg_dump` / `pg_restore` mais a cópia do `master.key`. A sessão do WhatsApp vai junto e não é preciso ler o QR Code de novo. Veja `docs/GUIA-DIGITALOCEAN.md`.

---

## 11. Fases de construção

| Fase | Entrega |
|---|---|
| 0 | Este documento, modelo de dados e decisões |
| 1 | Servidor, conexões QR (multinúmero), login 2FA, setores, caixa de entrada multiatendente e tempo real |
| 2 | Motor de IA: provedores, roteamento por tarefa, base de conhecimento (RAG), qualificação híbrida, transferência, compliance e cartão de contexto |
| 3 | Construtor de fluxos: editor visual, motor de execução, versões, simulador, validação e métricas |
| 4 | Consultas a bases externas, follow-ups, horários e feriados, webhooks e relatórios |
| 5 | Instaladores (servidor e desktop), Docker para a DigitalOcean, endurecimento e guias |

---

## 12. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| Bloqueio do número (conexão não oficial) | Alto | Ritmo humano, sem massa, follow-up limitado e monitor de saúde da conexão |
| Mudança no protocolo do WhatsApp Web | Médio | Versão consultada a cada conexão, patch isolado em `patches/` e Baileys fixado em versão exata |
| IA responder algo regulatoriamente inadequado | Alto | Três camadas de guarda, bloqueio com transferência e auditoria |
| Servidor local cair | Médio | Reconexão automática; mensagens recebidas no período são recuperadas na reconexão |
| Vazamento de dados para provedores de IA | Médio | Documentos pessoais não vão para a IA, consultas com máscaras e opção de provedor por tarefa |

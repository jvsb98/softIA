# Multi-cliente: como funciona e regras para o código

## Em uma frase

Toda requisição, tarefa da fila e evento do WhatsApp roda dentro de um **contexto**: de um cliente (o banco só enxerga o schema `t_<slug>`) ou da plataforma (o banco enxerga o schema `plataforma`). Fora de um contexto, qualquer consulta **falha**.

## Peças

| Peça | Arquivo | O que faz |
|---|---|---|
| Contexto | `src/lib/tenant.ts` | `AsyncLocalStorage` com `{kind:'tenant', id, slug, schema, name, status}` ou `{kind:'platform'}`. `withTenant`, `withPlatform`, `runInCtx`, `currentTenant`, `tenantOrNull`, `ctxKey` |
| Banco | `src/lib/db.ts` | Um pool só. `q/one/tx` pegam uma conexão e aplicam `SET search_path TO t_x, <schema das extensões>` quando ela veio de outro contexto. `public` só entra se alguma extensão estiver lá, e então o servidor só sobe se `public` não tiver tabelas. Sem contexto → `NoContextError`. Pooler em modo transação (porta 6543) é recusado |
| Migrações | `migrations/platform`, `migrations/tenant` | `migrate()` aplica a plataforma e depois cada cliente (exceto cancelados), com trava consultiva. Cada schema tem a própria `schema_migrations` |
| Registro de clientes | `src/platform/tenants.ts` | Resolve o hostname (cache de 60 s; desconhecido, 5 s; no máximo 5.000 entradas), cria cliente (recusa schema que já exista; rollback apaga registro e depois schema), muda situação |
| Avisos entre processos | `src/platform/events.ts` | `NOTIFY softia_platform`: suspender/cancelar para o WhatsApp e derruba os sockets do cliente nos servidores rodando |
| HTTP | `src/http/app.ts` | Gancho `onRequest` resolve o `Host` e roda a requisição no contexto; reabre em `preValidation`. Hostname desconhecido → 404; cliente suspenso → 503. `/api/health` e `/api/platform/tls-check` atendem qualquer hostname |
| Tempo real | `src/http/realtime.ts` | O cliente vem do `Host` do handshake; toda sala tem o prefixo `t:<id>:`; a origem precisa ser o próprio cliente |
| Fila | `src/lib/jobs.ts` | `plataforma.jobs` com `tenant_id`. `enqueue` grava o cliente atual; o worker reabre o contexto. Singleton e `groupKey` valem por cliente. `every()` enfileira uma tarefa por cliente ativo. Cliente suspenso: a tarefa espera 1 h sem gastar tentativa |
| WhatsApp | `src/whatsapp/manager.ts` | Conexões indexadas por `<cliente>:<conexão>`; eventos do Baileys tratados no contexto do dono. `plataforma.wa_leases` garante um único processo por número (batimento de 15 s, validade de 45 s) |
| Sessão | `src/http/app.ts` | Cookie sem atributo `Domain`: vale só no subdomínio onde foi criado |

## Regras para quem mexe no código

1. **Nunca use `db().query` para dados.** Use `q/one/tx`. `db()` é só para `LISTEN/NOTIFY` e travas.
2. **Tabela nova de cliente** → arquivo novo em `migrations/tenant/` (nome sequencial). **Tabela da plataforma** → `migrations/platform/`. Nunca altere uma migração já publicada.
3. **Tabela da plataforma em código de cliente:** sempre qualificada (`plataforma.jobs`) e sempre filtrada pelo `tenant_id` do contexto.
4. **Cache em memória:** se a chave não for um UUID, prefixe com `ctxKey()`.
5. **Código que roda fora de uma requisição** (timer, evento de biblioteca, callback): capture o contexto (`currentCtx()`) quando criar e rode com `runInCtx(ctx, ...)`.
6. **Evento de tempo real:** use `emitStaff/emitManagers/emitUser/emitConversation`; eles colocam o prefixo do cliente sozinhos.
7. **Requisição para URL informada por usuário:** `safeFetch` (bloqueia rede interna e confere o IP na conexão).
8. Rode `apps/server/scripts/test-isolation.mjs` antes de abrir um pull request que mexa em banco, sessão, fila ou tempo real.

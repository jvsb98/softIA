# softIA

SaaS white label de atendimento no WhatsApp para pequenas empresas (marmorarias, clínicas, consultórios): conexão por QR Code, inbox multiatendente, fluxos de atendimento, IA, agenda e CRM. Cada cliente acessa pelo próprio subdomínio (`<cliente>.connectawork.app.br`), com dados isolados num schema próprio do PostgreSQL. O fornecedor monta e libera os módulos de cada cliente.

Nasceu como fork do **Nimber Atende 1.0.4** (histórico preservado; as tags antigas têm o prefixo `atende-`). O documento de arquitetura e o roadmap ficam no projeto do claude.ai: "SaaS de Atendimento WhatsApp — Arquitetura (Fase 0)".

## Situação

| Fase | Conteúdo | Situação |
|---|---|---|
| 0 | Arquitetura e inventário | Concluída |
| 1 | Fundação multi-cliente: schema por cliente, contexto por subdomínio, fila/tempo real/WhatsApp por cliente, deploy no Droplet compartilhado | **Esta versão (0.1.0)** |
| 2 | Painel do fornecedor: perfis, criar cliente em 5 passos, módulos e limites, white label, entrar como cliente, medidor de IA | Próxima |
| 3 | Agenda (Google e Microsoft, profissionais + serviços, lembretes) | — |
| 4 | CRM em funil (portado da Central WhatsApp) e modelos de segmento → piloto | — |
| 5 | Disparo pela Z-API | — |
| 6 | Operação: backup por cliente, alertas, manuais | — |

## Guias

| Para… | Leia |
|---|---|
| Subir no Droplet da Central com banco no Supabase | [docs/DEPLOY.md](docs/DEPLOY.md) |
| Entender o multi-cliente (regras para quem mexe no código) | [docs/MULTI-CLIENTE.md](docs/MULTI-CLIENTE.md) |
| Usar no dia a dia (atendentes, supervisores, admins do cliente) | [docs/GUIA-USO.md](docs/GUIA-USO.md) |
| Segurança e LGPD | [docs/SEGURANCA-LGPD.md](docs/SEGURANCA-LGPD.md) |
| Tabelas do schema de cada cliente | [docs/MODELO-DE-DADOS.md](docs/MODELO-DE-DADOS.md) |
| O que mudou em cada versão | [CHANGELOG.md](CHANGELOG.md) |

## Estrutura

```
softia/
├─ apps/
│  ├─ server/              Node.js 22 + TypeScript (Fastify, Socket.IO, Baileys, PostgreSQL)
│  │  ├─ migrations/
│  │  │  ├─ platform/      schema "plataforma": clientes, domínios, fila, leases do WhatsApp
│  │  │  └─ tenant/        schema de cada cliente (t_<slug>): tudo o que o Atende já tinha
│  │  ├─ scripts/          test-isolation.mjs (dois clientes, nenhum dado cruzado)
│  │  └─ src/              lib/tenant.ts (contexto) · platform/ · auth · whatsapp · inbox · ai · flows · integrations · ops · http
│  └─ web/                 Painel React 19 + Vite + Tailwind 4 (servido pelo próprio servidor)
├─ deploy/
│  ├─ docker/              Dockerfile, compose (dedicado ou compartilhado), .env.example
│  ├─ caddy/               softia.global + softia.site (on-demand TLS por subdomínio)
│  └─ central/             patch do Caddy da Central para importar os trechos acima
├─ patches/                Correção do Baileys para o pareamento por QR Code
└─ .github/workflows       CI (inclui o teste de isolamento) e imagem Docker (GHCR)
```

## Rodar em desenvolvimento

Pré-requisitos: Node.js 22 e PostgreSQL 14+ (com pgvector, se possível).

```bash
npm install
export NIMBER_DB_HOST=localhost NIMBER_DB_NAME=softia NIMBER_DB_USER=postgres NIMBER_DB_PASSWORD=...
export BASE_DOMAIN=localhost PUBLIC_URL=http://painel.localhost:8080
npm run migrate
npm run cli -w apps/server -- tenant:create alfa --name "Marmoraria Alfa" --admin-name Ana --admin-email ana@alfa.com --password SenhaAlfa123
npm run dev:server        # API na porta 8080
npm run dev:web           # painel: abra http://alfa.localhost:5173  (o subdomínio diz qual cliente é)
```

Navegadores resolvem `*.localhost` para a própria máquina, então cada cliente de teste tem o seu endereço local (`alfa.localhost`, `beta.localhost`). Dados de exemplo: `npm run cli -w apps/server -- seed-demo --tenant alfa`.

| Comando | O que faz |
|---|---|
| `npm run typecheck` | Verifica tipos do servidor e do painel |
| `npm test` | Testes unitários |
| `npm run build` | Compila painel e servidor |
| `node apps/server/scripts/test-isolation.mjs` | Teste ponta a ponta de isolamento (servidor rodando; veja o cabeçalho do arquivo) |
| `npm run cli -w apps/server -- <comando>` | `migrate`, `check`, `tenant:create`, `tenant:list`, `tenant:status`, `reset-admin --tenant`, `seed-demo --tenant`, `export-key`, `import-key`, `backup` |

## Licença

Uso restrito. Todos os direitos reservados.

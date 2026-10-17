# Nimber Atende

Atendimento no WhatsApp com IA para a Nimber: o agente de IA qualifica leads, tira dúvidas sobre a plataforma de tokenização e passa a conversa para a pessoa certa (SDR, Closer, Suporte), com vários atendentes no mesmo número, vários números e um construtor visual de fluxos.

Roda no próprio servidor da Nimber (Windows, como serviço) e depois na DigitalOcean (Docker), com o banco PostgreSQL apontado por um arquivo de texto.

---

## O que tem

| Área | Recursos |
|---|---|
| **WhatsApp** | Conexão nativa por QR Code (Baileys, mesmo núcleo do Extrator de Integrantes, com a correção de pareamento). Vários números. O número continua no celular da equipe: quando alguém responde pelo celular, a IA pausa naquela conversa. Ritmo de envio humano (digitando…, intervalos, limite por minuto). |
| **Caixa de entrada** | Multiatendente em tempo real, filas por setor, distribuição (rodízio, menos ocupado ou puxar da fila), transferência com motivo, notas internas com @menção, respostas rápidas com "/", etiquetas, mídia (áudio, imagem, documento), conversas iniciadas pelo atendente. |
| **IA** | Vários provedores (Anthropic, OpenAI, Gemini, compatíveis) com modelo por tarefa e reserva automática. Qualificação híbrida com score, base de conhecimento (documentos, FAQ, site) com busca por palavras e por significado, transcrição de áudio, sugestão de resposta e resumo para o atendente. |
| **Compliance** | Três travas em camadas — sem promessa de rentabilidade, sem recomendação personalizada, sem orientação jurídica/tributária. Resposta bloqueada não sai, vira transferência para humano e fica auditada. Disclaimer automático. |
| **Fluxos** | Construtor visual (estilo n8n) com 19 tipos de nó, rascunho/publicado, versões com restauração, validação antes de publicar, simulador e métricas por nó. Permissões: negócio monta fluxos, tecnologia libera nós avançados (HTTP, código). |
| **Integrações** | Consultas somente leitura a PostgreSQL/MySQL/SQL Server (ex.: ofertas abertas, carteira do investidor) usadas pela IA e pelos fluxos, com verificação de identidade antes de dados pessoais e máscaras LGPD. Webhooks assinados (n8n, CRM). Alertas no Slack. Follow-ups automáticos com opt-out. |
| **Gestão** | Relatórios (volume, automação, transferências, funil, tempos por setor e atendente, mapa de calor, uso da IA), horários e feriados, auditoria, retenção e anonimização (LGPD). |
| **Acesso** | Login próprio com 2FA (TOTP) obrigatório para administradores, códigos de recuperação, bloqueio por tentativas, sessões revogáveis. Navegador ou app desktop para Windows (bandeja, notificações nativas, contador na barra de tarefas). |

---

## Guias

| Para… | Leia |
|---|---|
| Subir este pacote para o GitHub e gerar os instaladores | [docs/COMO-SUBIR-NO-GITHUB.md](docs/COMO-SUBIR-NO-GITHUB.md) |
| Instalar no servidor Windows da Nimber | [docs/GUIA-INSTALACAO-WINDOWS.md](docs/GUIA-INSTALACAO-WINDOWS.md) |
| Levar para a DigitalOcean | [docs/GUIA-DIGITALOCEAN.md](docs/GUIA-DIGITALOCEAN.md) |
| Usar no dia a dia (atendentes, supervisores, admins) | [docs/GUIA-USO.md](docs/GUIA-USO.md) |
| Segurança e LGPD | [docs/SEGURANCA-LGPD.md](docs/SEGURANCA-LGPD.md) |
| Arquitetura e decisões | [docs/ARQUITETURA.md](docs/ARQUITETURA.md) |
| Tabelas do banco | [docs/MODELO-DE-DADOS.md](docs/MODELO-DE-DADOS.md) |
| O que mudou em cada versão | [CHANGELOG.md](CHANGELOG.md) |

---

## Estrutura

```
nimber-atende/
├─ apps/
│  ├─ server/        Servidor Node.js 22 + TypeScript (Fastify, Socket.IO, Baileys, PostgreSQL)
│  │  ├─ migrations/ SQL versionado (aplicado sozinho na inicialização)
│  │  └─ src/        auth · whatsapp · inbox · ai · flows · integrations · ops · http
│  ├─ web/           Painel React 19 + Vite + Tailwind 4 (servido pelo próprio servidor)
│  └─ desktop/       App desktop Electron (Windows)
├─ config/           Modelos de database.txt e server.txt (os reais nunca vão para o Git)
├─ deploy/
│  ├─ windows/       Instalador Inno Setup + serviço WinSW + script de build
│  └─ docker/        Dockerfile, docker-compose (Postgres opcional) e Caddy (HTTPS)
├─ patches/          Correção do Baileys para o pareamento por QR Code (aplicada no npm install)
├─ scripts/          Empacotamento do servidor e troca de versão
└─ .github/workflows CI, instaladores Windows e imagem Docker
```

---

## Rodar em desenvolvimento

Pré-requisitos: Node.js 22, PostgreSQL 14+ (com pgvector, se possível) e Git.

```bash
npm install                                  # instala tudo e aplica o patch do Baileys
cp config/database.example.txt config/database.txt   # preencha HOST, PORT, DATABASE, USER, PASSWORD
npm run migrate                              # cria as tabelas
npm run dev:server                           # API em http://localhost:8080
npm run dev:web                              # painel em http://localhost:5173 (com recarga automática)
```

Na primeira vez, o painel pede para criar o administrador e configurar o 2FA. Sem chave de IA, o provedor **Simulado** responde de forma heurística para testar fluxos e telas sem custo. Para popular conversas de exemplo: `npm run cli -w apps/server -- seed-demo`.

| Comando | O que faz |
|---|---|
| `npm run typecheck` | Verifica tipos do servidor e do painel |
| `npm test` | Testes unitários (TOTP, compliance, qualificação, base de conhecimento, consultas, rede) |
| `npm run build` | Compila painel e servidor |
| `npm run package:server` | Monta `out/nimber-atende/` (servidor + painel + dependências de produção) |
| `node scripts/set-version.mjs 1.1.0` | Troca a versão em todos os pacotes |
| `npm run cli -w apps/server -- <comando>` | `check`, `migrate`, `reset-admin <e-mail>`, `export-key`, `import-key`, `seed-demo` |

---

## Licença

Uso interno da Nimber. Todos os direitos reservados.

# Changelog

Todas as mudanças relevantes do Nimber Atende. Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem [SemVer](https://semver.org/lang/pt-BR/).

## [1.0.3] — 2026-10-17

### Corrigido
- A página principal ficava 1 hora em cache no navegador (`max-age=3600`): depois de atualizar, o navegador podia continuar com a página antiga, apontando para arquivos que não existem mais. Agora a página é sempre revalidada e só os arquivos com hash (`/assets`) ficam em cache.
- Arquivo inexistente (ex.: script antigo do painel) respondia com a página HTML e status 200; o navegador recusava como script e a tela ficava em branco sem mensagem. Agora responde 404.

### Adicionado
- Vigia de carregamento (`boot.js`): se o painel não abrir ou parar com erro, a tela mostra o motivo, o teste dos arquivos e os botões "Recarregar sem cache" e "Copiar diagnóstico". Na primeira falha recarrega sozinho.
- Atualizador com autoteste: encerra servidores antigos do projeto, recompila do zero, sobe o servidor, testa as respostas HTTP e abre o painel num navegador sem interface (Edge/Chrome), gerando `diagnostico-nimber-atende.txt`.

## [1.0.2] — 2026-10-16

### Corrigido
- Tela em branco depois do login com 2FA: o painel agora abre com um carregamento completo da página após o login (extensões do navegador que mexem nos campos de senha não derrubam mais a transição) e a tradução automática do navegador fica desligada.
- Acesso pela rede por IP ou nome da máquina (sem HTTPS) deixava a página em branco: a política de segurança forçava `https` nos arquivos do painel. Agora isso só vale quando o endereço público é HTTPS.

### Adicionado
- Proteção contra erros de tela: em vez de página vazia, o painel mostra a mensagem do erro com as opções Recarregar, Copiar mensagem e Sair. Conflitos causados por extensões recarregam a página sozinhos.

## [1.0.1] — 2026-10-16

### Corrigido
- Instalação num banco já existente com schema próprio (`SCHEMA=` no `database.txt`): quando as extensões ainda não existiam, elas eram criadas nesse schema e a migração falhava ao montar a busca sem acento. A função de busca agora usa o schema onde o `unaccent` estiver.

### Adicionado
- Variável de ambiente `NIMBER_DB_SCHEMA` (Docker), equivalente ao `SCHEMA=` do `database.txt`.

## [1.0.0] — 2026-10-16

Primeira versão completa, construída em seis fases (cada uma é um commit e uma tag `fase-N` no histórico).

### Fase 5 — Instalação e distribuição
- Instalador do servidor para Windows (Inno Setup): pergunta os dados do PostgreSQL, protege a configuração, aplica migrações, instala o serviço "Nimber Atende" (WinSW, início automático e reinício em falha) e libera o firewall. Atualização por cima mantendo configuração.
- App desktop (Electron) para os atendentes: tela de conexão ao servidor, bandeja, notificações nativas, contador de pendências na barra de tarefas, início com o Windows, tela de servidor indisponível com nova tentativa, endereço pré-configurável pela TI.
- Imagem Docker e docker-compose para a DigitalOcean, com PostgreSQL opcional e HTTPS automático (Caddy). Configuração só por variáveis de ambiente.
- GitHub Actions: CI (tipos, testes, build, migrações num banco limpo, smoke test), instaladores Windows em cada tag `v*` e imagem no GHCR.
- Comando `backup` (pg_dump com rotação, usando a senha protegida do serviço).
- Segurança: trava contra criação simultânea do primeiro administrador, redação de segredos nos logs, bloqueio de requisições ao serviço de metadados da nuvem (com checagem a cada redirecionamento).
- Botão para anonimizar o titular (LGPD) no painel do contato.
- Correção: a raiz `/` do painel respondia 403 quando acessada diretamente.
- Documentação: README, guia para subir no GitHub, instalação no Windows, DigitalOcean, uso, segurança/LGPD e modelo de dados.

### Fase 4 — Integrações e gestão
- Consultas somente leitura a PostgreSQL, MySQL e SQL Server, usadas pela IA (ferramentas) e pelos fluxos (nó "Consultar base de dados"), com verificação de identidade, máscaras e auditoria.
- Webhooks assinados com HMAC SHA-256, novas tentativas e registro de entregas.
- Follow-ups automáticos só para quem interagiu, com opt-out por palavra-chave.
- Alertas no Slack (conexão caída, bloqueio de compliance) e cadastro de feriados.
- Relatórios: volume diário, automação, transferências e motivos, funil de leads, setores, atendentes, mapa de calor e uso da IA.

### Fase 3 — Construtor de fluxos
- Editor visual com 19 tipos de nó, rascunho e publicado, versões com restauração, validação antes de publicar, simulador e métricas por nó.
- Modelos prontos: qualificação SDR, triagem de suporte, cadastro rápido.
- Permissões: negócio edita fluxos; nós avançados (HTTP, código) só com permissão.

### Fase 2 — Inteligência artificial
- Provedores Anthropic, OpenAI, Gemini, compatíveis com OpenAI e simulado; modelo por tarefa com reserva automática e registro de consumo.
- Agente com qualificação híbrida (critérios + score), base de conhecimento (documentos, FAQ, site) com busca por palavras e por significado, transcrição de áudio, sugestão de resposta e cartão de contexto na transferência.
- Travas de compliance em três camadas e disclaimer automático (texto pendente de validação).

### Fase 1 — Núcleo
- Servidor Node.js com PostgreSQL, fila de tarefas própria e tempo real.
- Conexão de WhatsApp por QR Code (Baileys com a correção de pareamento do Extrator de Integrantes), vários números, pausa da IA quando a equipe responde pelo celular, ritmo de envio humano.
- Login com 2FA, papéis e auditoria; caixa de entrada multiatendente com filas por setor, distribuição, transferência, notas, respostas rápidas, etiquetas e mídia; horários por setor com mensagem fixa fora do horário.
- Configuração do banco por `database.txt` com senha protegida por DPAPI no Windows.

### Fase 0 — Arquitetura
- Documento de arquitetura com as 18 decisões, modelo de dados, IA, compliance, segurança/LGPD, proteção do número e plano de implantação.

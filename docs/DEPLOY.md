# Subir o softIA no Droplet da Central (com banco no Supabase)

Configuração provisória decidida em 25/10/2026: o softIA roda no **mesmo Droplet da Central WhatsApp**, com o banco num **projeto novo do Supabase** usado só como PostgreSQL.

```
 navegador ── https://alfa.connectawork.app.br ──┐
 navegador ── https://painel.connectawork.app.br ┤
 navegador ── https://<domínio da Central> ──────┤
                                                 ▼
 ┌──────────────────── Droplet central-whatsapp ─────────────────────┐
 │ central-whatsapp-site (Caddy, portas 80/443)                       │
 │   ├─ domínio da Central → arquivos da Central                      │
 │   └─ qualquer outro hostname → softia:8080 (on-demand TLS)         │
 │ central-whatsapp-servidor (WhatsApp da Central)                    │
 │ softia (contêiner, limite de memória próprio)                      │
 └───────────────────────────────┬────────────────────────────────────┘
                                 │ TLS, pooler em MODO SESSÃO (5432)
                       Supabase (projeto novo, só PostgreSQL)
```

## 1. Preparar o Droplet (uma vez)

**Memória.** O Droplet tem 1 GB de RAM e já roda a Central. Antes de subir o softIA:

1. No painel da DigitalOcean: Droplet → **Resize** → **CPU and RAM only** → pelo menos **2 GB**. Essa opção mantém o disco, permite voltar ao tamanho atual depois e deixa o Droplet desligado por poucos minutos.
2. Crie 2 GB de swap como margem de segurança:
   ```bash
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   sysctl vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.d/99-swap.conf
   ```
3. Confira com `free -h`.

O contêiner do softIA tem limite de memória (`SOFTIA_MEM_LIMIT`, padrão 900 MB): se ele passar disso, só ele reinicia, e a Central continua no ar.

## 2. DNS no Registro.br

No Registro.br, em **DNS → Editar zona** (modo avançado), crie as entradas:

| Tipo | Nome | Valor |
|---|---|---|
| A | `*` | IP do Droplet |
| A | `painel` | IP do Droplet (só se a entrada `*` não for aceita) |

Para conferir, rode `dig +short alfa.connectawork.app.br` e veja se aparece o IP do Droplet.

**Se o painel não aceitar a entrada `*`:** crie um registro A por cliente (`alfa`, `beta`…) a cada cliente novo, ou passe o DNS do domínio para a Cloudflare (gratuita), copiando antes os registros que já existem.

## 3. Banco no Supabase

1. Crie um **projeto novo** (não use o da Central), na **mesma região do Droplet**.
2. **Desligue a Data API** em Project Settings → Data API, ou, no mínimo, não exponha os schemas `plataforma` e `t_*`. O softIA não usa a API do Supabase e não grava nada no schema `public`.
3. Pegue a conexão em **Connect → Session pooler** (porta **5432**).
   - **Nunca use o "Transaction pooler" (porta 6543).** Ele quebra a troca de schema por cliente, a fila de tarefas (`LISTEN/NOTIFY`) e as travas de migração.
   - A conexão direta (`db.<id>.supabase.co`) também funciona, mas usa IPv6 por padrão.
4. Usuário no formato `postgres.<id-do-projeto>`, banco `postgres`, `NIMBER_DB_SSL=no-verify`. Para validar o certificado, baixe o CA em Database → SSL Configuration, coloque em `/opt/softia/ca.crt` e use `NIMBER_DB_SSL=true` com `NIMBER_DB_SSL_CA=ca.crt`, descomentando a linha do volume no compose.

As extensões (pgvector, unaccent, pg_trgm) são criadas sozinhas no schema `extensions` na primeira subida.

**Plano gratuito:** serve para desenvolvimento e testes. Projeto gratuito é pausado depois de 7 dias com pouca atividade e o banco é pequeno. Passe para um plano pago antes do primeiro cliente pagante.

## 4. Ajuste no Caddy da Central (uma vez)

O Caddy da Central passa a importar trechos de outros sistemas da pasta `/opt/caddy-extra`. Com a pasta vazia, nada muda.

1. Aplique `deploy/central/central-caddy-extra.patch` no repositório `central-whatsapp` (no seu computador ou no GitHub), faça o commit e o push:
   ```bash
   cd central-whatsapp && git apply /caminho/softia/deploy/central/central-caddy-extra.patch
   git commit -am "Caddy: importa trechos de outros sistemas do Droplet" && git push
   ```
2. No Droplet: `cd /opt/central-whatsapp && bash scripts/atualizar.sh`. A Central fica alguns segundos fora do ar enquanto o contêiner do site é recriado.

## 5. Subir o softIA

```bash
mkdir -p /opt/softia /opt/caddy-extra && cd /opt/softia
R=https://raw.githubusercontent.com/jvsb98/softIA/main
curl -fsSLO $R/deploy/docker/docker-compose.yml
curl -fsSLO $R/deploy/docker/docker-compose.compartilhado.yml
curl -fsSL  $R/deploy/docker/.env.example -o .env.example
curl -fsSLO $R/deploy/caddy/softia.global
curl -fsSLO $R/deploy/caddy/softia.site
cp .env.example .env && chmod 600 .env && nano .env   # BASE_DOMAIN, PUBLIC_URL, NIMBER_DB_*, NIMBER_MASTER_KEY
```

> Se o repositório virar privado, o `curl` precisa de token. Aí é mais simples copiar os arquivos com `scp`.

- **Chave-mestra:** gere com `openssl rand -base64 32`, coloque em `NIMBER_MASTER_KEY` e guarde uma cópia fora do servidor. Sem ela, os segredos gravados no banco (2FA, chaves de IA) não podem ser lidos.
- **Imagem:** o GitHub Actions publica `ghcr.io/jvsb98/softia:main` a cada push na `main`. Se o `pull` responder `denied` ou `unauthorized`, o pacote está privado: faça login uma vez no Droplet com um token do GitHub (permissão `read:packages`), ou deixe o pacote público em GitHub → Packages → softia → Package settings:
  ```bash
  echo <TOKEN> | docker login ghcr.io -u jvsb98 --password-stdin
  ```

Para subir:

```bash
C="docker compose -f docker-compose.yml -f docker-compose.compartilhado.yml"
$C pull && $C up -d
curl -s http://127.0.0.1:8080/api/health      # {"ok":true,"app":"softia",...}

# Trechos do Caddy (on-demand TLS) e recarga do Caddy da Central
cp softia.global softia.site /opt/caddy-extra/
docker exec central-whatsapp-site-1 caddy reload --config /etc/caddy/Caddyfile
```

## 6. Primeiro acesso ao painel do fornecedor

Crie o seu acesso de super admin (uma vez):

```bash
docker compose -f docker-compose.yml -f docker-compose.compartilhado.yml exec softia \
  node server/dist/cli.js platform:create-admin --name "João Victor" --email ti@nimber.com.br
```

A saída mostra uma senha temporária. Abra `https://painel.connectawork.app.br`, entre, crie a sua senha e ative a verificação em duas etapas (obrigatória para toda a equipe do fornecedor; use um aplicativo como Google Authenticator ou Authy).

No painel:

- **Clientes → Novo cliente**: cinco passos (empresa e endereço, marca, módulos e limites, administrador, revisão). No fim aparecem a senha temporária do administrador do cliente e uma mensagem pronta para enviar pelo WhatsApp. Na primeira visita ao subdomínio, o Caddy emite o certificado, o que leva alguns segundos.
- **Ficha do cliente**: situação dos números, módulos, limites, marca (nome, cor e logo), dados e cobrança, e **Entrar como cliente** (abre o ambiente dele em outra aba, por até 2 horas, registrado na auditoria dos dois lados).
- **Equipe**: adicione implantadores e suporte. Só o super admin muda a situação de um cliente (suspender, cancelar), mexe na equipe e nos provedores de IA.
- **IA (provedores e modelos)**: cadastre a chave da plataforma (OpenAI, Anthropic etc.) uma vez; vale para todos os clientes com o módulo IA, cada um com a sua franquia mensal.

Comandos de apoio, sempre com `exec softia node server/dist/cli.js`:

| Comando | O que faz |
|---|---|
| `platform:create-admin --name N --email E [--role implantador\|suporte]` | Cria alguém da equipe do fornecedor (padrão: super admin) |
| `tenant:create alfa --name "Marmoraria Alfa" --admin-name Ana --admin-email ana@alfa.com.br --segment marmoraria` | Cria um cliente sem passar pelo painel |
| `tenant:list` | Lista os clientes, a situação e os endereços |
| `tenant:status alfa suspenso` | Suspende, reativa (`ativo`) ou cancela; o servidor para ou retoma as conexões de WhatsApp e as sessões abertas na hora |
| `reset-admin ana@alfa.com.br --tenant alfa` | Senha temporária e remoção do 2FA de um usuário do cliente |
| `migrate` | Aplica migrações (o servidor já faz isso ao subir) |

## 7. Atualizar

```bash
cd /opt/softia && C="docker compose -f docker-compose.yml -f docker-compose.compartilhado.yml"
$C pull && $C up -d && docker image prune -f
```

As migrações rodam sozinhas ao subir, para a plataforma e para todos os clientes. As sessões do WhatsApp ficam no banco, então os números voltam sem precisar ler o QR Code de novo.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| "Endereço não encontrado" no subdomínio | Cliente não existe, ou o slug está diferente do endereço |
| Erro de certificado na primeira visita | O DNS ainda não aponta para o Droplet, ou os trechos do Caddy não foram copiados ou recarregados |
| "pooler em modo transação ... não é suportada" ao subir | `NIMBER_DB_PORT=6543`; troque para o pooler em modo sessão (5432) |
| "O schema public deste banco tem N tabela(s)" ao subir | O banco não está vazio; use um projeto/banco novo para o softIA |
| `type "vector" does not exist` | Extensão criada fora do schema `extensions` ou `public`; rode `migrate` de novo |
| Contêiner reiniciando por memória | Aumente o Droplet ou o `SOFTIA_MEM_LIMIT`; confira `docker stats` |

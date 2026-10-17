# Levar o Nimber Atende para a DigitalOcean

Depois dos testes no servidor Windows, o sistema roda num **Droplet** (Linux + Docker) com o **PostgreSQL gerenciado** da DigitalOcean e HTTPS automático. As sessões do WhatsApp ficam no banco, então os números migram **sem ler o QR Code de novo**.

```
 Atendentes (navegador / app desktop)
          │ https://atende.nimber.com.br
          ▼
 ┌─────────── Droplet (Ubuntu + Docker) ───────────┐
 │  Caddy (HTTPS)  ──►  Nimber Atende (contêiner)  │──► WhatsApp, provedores de IA
 └─────────────────────────────┬───────────────────┘
                               │ SSL, rede privada (VPC)
                     PostgreSQL gerenciado (backups diários)
```

> **Por que Droplet e não App Platform?** Cada número de WhatsApp só pode ter uma conexão ativa. O App Platform sobe a versão nova antes de desligar a antiga, o que abre duas conexões ao mesmo tempo. No Droplet a troca é controlada.

## Antes de começar

- Conta na DigitalOcean com acesso de administrador ao time da Nimber.
- Domínio com acesso ao DNS (ex.: `atende.nimber.com.br`).
- Imagem publicada pelo GitHub Actions em `ghcr.io/<dono>/nimber-atende` (veja [COMO-SUBIR-NO-GITHUB.md](COMO-SUBIR-NO-GITHUB.md)).
- Um token do GitHub para baixar a imagem privada: **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**, só com o escopo `read:packages`.
- A chave mestra do servidor Windows (`nimber-cli export-key`), se for migrar dados.

### LGPD: região dos dados

A DigitalOcean não tem região no Brasil. Hospedar em Nova York ou Toronto é transferência internacional de dados pessoais (LGPD, art. 33). Valide com o encarregado (DPO) e o jurídico da Nimber, registre a base legal e confira se o contrato/DPA da DigitalOcean está aceito na conta.

## 1. Criar o PostgreSQL gerenciado

1. **Create → Databases → PostgreSQL 16**. Região: a mesma do Droplet (ex.: NYC3). Plano: 1 GB/1 vCPU basta para começar.
2. Quando ficar pronto, aba **Users & Databases**: crie o usuário `nimber_atende` e o banco `nimber_atende`.
3. Aba **Overview → Connection details**: anote host, porta (25060), e baixe o **CA certificate** (`ca-certificate.crt`).
4. Conecte como `doadmin` (o painel mostra o comando `psql` pronto, troque o banco para `nimber_atende`) e rode:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO nimber_atende;
```

5. Aba **Settings → Trusted sources**: depois de criar o Droplet (passo 2), adicione-o aqui. Só ele poderá acessar o banco.

## 2. Criar o Droplet

1. **Create → Droplets**: Ubuntu 24.04 LTS, mesma região e mesma VPC do banco, plano Basic de **2 vCPU / 4 GB**. Autenticação por chave SSH.
2. **Networking → Firewalls → Create firewall** e aplique ao Droplet:
   - Entrada: SSH (22) só do IP do escritório; HTTP (80) e HTTPS (443) de qualquer lugar.
3. Entre por SSH e instale o Docker:

```bash
ssh root@IP_DO_DROPLET
curl -fsSL https://get.docker.com | sh
timedatectl set-timezone America/Sao_Paulo
```

## 3. Apontar o domínio

No DNS do domínio, crie um registro **A**: `atende` → IP do Droplet. Espere propagar (`ping atende.nimber.com.br` deve responder com o IP) antes do passo 5, senão o certificado HTTPS não é emitido.

## 4. Preparar os arquivos no Droplet

```bash
mkdir -p /opt/nimber-atende && cd /opt/nimber-atende
# só a pasta de implantação é necessária (copie do repositório):
#   deploy/docker/docker-compose.yml, deploy/docker/Caddyfile, deploy/docker/.env.example
# por exemplo, do seu computador:  scp deploy/docker/{docker-compose.yml,Caddyfile,.env.example} root@IP:/opt/nimber-atende/
cp .env.example .env
nano .env
```

Preencha o `.env`:

```ini
DOMAIN=atende.nimber.com.br
PUBLIC_URL=https://atende.nimber.com.br
NIMBER_IMAGE=ghcr.io/<dono>/nimber-atende:latest

NIMBER_DB_HOST=<host privado do banco, "private-db-postgresql-...">
NIMBER_DB_PORT=25060
NIMBER_DB_NAME=nimber_atende
NIMBER_DB_USER=nimber_atende
NIMBER_DB_PASSWORD=<senha do usuário nimber_atende>
NIMBER_DB_SSL=true
NIMBER_DB_SSL_CA=ca-certificate.crt

NIMBER_MASTER_KEY=<saída do export-key do Windows; em branco numa instalação nova>
```

Copie o `ca-certificate.crt` para `/opt/nimber-atende/` e descomente no `docker-compose.yml` a linha:

```yaml
      - ./ca-certificate.crt:/config/ca-certificate.crt:ro
```

Proteja o `.env`: `chmod 600 .env`.

Entre no registro de imagens do GitHub (uma vez):

```bash
echo <TOKEN_read:packages> | docker login ghcr.io -u <seu-usuario-github> --password-stdin
```

## 5. Migrar os dados do Windows (se já estiver em uso)

Faça numa janela combinada com a equipe (15 a 30 minutos sem atendimento pelo painel; as mensagens recebidas no período ficam no celular e chegam ao sistema quando ele volta).

**No servidor Windows** (Prompt como administrador):

```bat
cd "C:\Program Files\Nimber Atende"
NimberAtende.exe stop
tools\nimber-cli.cmd backup --out C:\migracao --keep 1
tools\nimber-cli.cmd export-key
```

> O serviço do Windows **precisa ficar parado** daqui em diante. Dois servidores ligados com a mesma sessão de WhatsApp derrubam um ao outro.

Copie o `.dump` de `C:\migracao` para o Droplet (WinSCP, ou `scp C:\migracao\nimber-atende-*.dump root@IP:/opt/nimber-atende/`).

**No Droplet**, restaure no banco gerenciado:

```bash
cd /opt/nimber-atende
docker run --rm -v "$PWD":/b -e PGPASSWORD='<senha nimber_atende>' -e PGSSLMODE=require postgres:16 \
  pg_restore --no-owner --no-privileges -h <host do banco> -p 25060 -U nimber_atende -d nimber_atende /b/nimber-atende-AAAAMMDD-HHMM.dump
```

Avisos sobre extensões já existentes podem ser ignorados.

## 6. Subir

```bash
cd /opt/nimber-atende
docker compose --profile https up -d
docker compose logs -f app      # Ctrl+C para sair
```

No log, procure "Banco pronto" e "Nimber Atende disponível em https://atende.nimber.com.br". Abra o endereço: numa instalação nova, crie o administrador; numa migração, entre com os usuários de sempre. As conexões de WhatsApp reconectam sozinhas.

Depois:

- Em **Configurações → Saúde do sistema**, confira banco, extensões e conexões.
- No app desktop de cada atendente: ícone da bandeja → **Trocar servidor…** → `https://atende.nimber.com.br`.
- Mantenha o servidor Windows desligado (ou desinstale) depois de alguns dias de operação estável.

## 7. Operação

| Tarefa | Comando (em `/opt/nimber-atende`) |
|---|---|
| Ver logs | `docker compose logs -f app` |
| Atualizar para a última versão | `docker compose pull app && docker compose --profile https up -d` |
| Fixar uma versão | `NIMBER_IMAGE=ghcr.io/<dono>/nimber-atende:1.1.0` no `.env` e repetir o comando acima |
| Reiniciar | `docker compose restart app` |
| Linha de comando do sistema | `docker compose exec app node server/dist/cli.js check` (também `reset-admin`, `export-key`) |
| Situação | `docker compose ps` (o app tem verificação de saúde a cada 30 s) |

### Backups

- O PostgreSQL gerenciado faz backup diário com restauração para qualquer ponto dos últimos 7 dias (**Databases → Backups**).
- Cópia semanal fora da DigitalOcean (opcional, recomendado):

```bash
# crontab -e   → domingo 3h
0 3 * * 0 cd /opt/nimber-atende && . ./.env && docker run --rm -v /opt/nimber-atende/backups:/b -e PGPASSWORD="$NIMBER_DB_PASSWORD" -e PGSSLMODE=require postgres:16 pg_dump -Fc -h "$NIMBER_DB_HOST" -p "$NIMBER_DB_PORT" -U "$NIMBER_DB_USER" -d "$NIMBER_DB_NAME" -f /b/nimber-$(date +\%Y\%m\%d).dump
```

  Depois envie `/opt/nimber-atende/backups` para um Spaces/S3 ou OneDrive com `rclone`.
- A chave mestra fica no `.env` (`NIMBER_MASTER_KEY`) ou no volume `/config`. Mantenha a cópia no cofre de senhas.

## Alternativa: banco no próprio Droplet

Para um ambiente de testes barato, sem banco gerenciado: deixe `NIMBER_DB_HOST` em branco no `.env` e suba com o perfil `local-db`:

```bash
docker compose --profile local-db --profile https up -d
```

O PostgreSQL (com pgvector) roda num contêiner com volume próprio. Os backups passam a ser responsabilidade sua (use o cron acima, apontando para `-h db` dentro da rede do compose ou `docker compose exec db pg_dump`).

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Caddy não emite o certificado | O DNS ainda não aponta para o Droplet, ou as portas 80/443 estão fechadas no firewall. `docker compose logs caddy`. |
| "no pg_hba.conf entry" / timeout no banco | O Droplet não está em **Trusted sources** do banco, ou o host usado é o público em vez do privado (VPC). |
| "self-signed certificate in certificate chain" | Falta o `ca-certificate.crt` montado em `/config` com `NIMBER_DB_SSL_CA=ca-certificate.crt`. Para um teste rápido, `NIMBER_DB_SSL=no-verify`. |
| Chaves de IA "não decifram" depois da migração | `NIMBER_MASTER_KEY` diferente da chave do Windows. Corrija e `docker compose up -d`. |
| `denied` ao baixar a imagem | Refaça o `docker login ghcr.io` com um token que tenha `read:packages` e acesso à organização. |

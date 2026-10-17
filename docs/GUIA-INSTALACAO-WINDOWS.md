# Instalação no servidor Windows

Passo a passo para colocar o Nimber Atende no servidor local da Nimber. Tempo estimado: 40 minutos.

## 1. O que você precisa

| Item | Recomendado |
|---|---|
| Servidor | Windows Server 2019/2022/2025 ou Windows 10/11 Pro, 64 bits, ligado 24h |
| Memória e disco | 8 GB de RAM e 20 GB livres (mínimo 4 GB) |
| Banco | PostgreSQL 16 (na mesma máquina ou em outra da rede) |
| Rede | Saída para a internet (WhatsApp e provedores de IA) e a porta do painel (padrão 8080) acessível pelos atendentes |
| Celular | O WhatsApp do número que será conectado, para ler o QR Code |
| Arquivos | `NimberAtendeServer-Setup-<versão>.exe` (Releases do GitHub) |

## 2. Instalar o PostgreSQL

Se a Nimber já tem um PostgreSQL 14+ na rede, pule para o item 2.2.

### 2.1 Instalação

1. Baixe o instalador do PostgreSQL 16 para Windows: <https://www.postgresql.org/download/windows/> (EDB).
2. Avance com as opções padrão. Anote a senha do usuário **postgres**. Porta: **5432**. Locale: padrão.
3. No final, desmarque o Stack Builder.

### 2.2 Criar o banco e o usuário

Abra **SQL Shell (psql)** no menu Iniciar, aperte Enter nas perguntas (servidor, banco, porta, usuário) e digite a senha do `postgres`. Depois rode, trocando a senha:

```sql
CREATE ROLE nimber_atende LOGIN PASSWORD 'troque-por-uma-senha-longa';
CREATE DATABASE nimber_atende OWNER nimber_atende ENCODING 'UTF8' TEMPLATE template0;
\c nimber_atende
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 2.3 Busca por significado (opcional, recomendado)

A base de conhecimento busca por palavras sempre. Com a extensão **pgvector**, ela também busca por significado ("quanto preciso para começar?" encontra o trecho sobre "aporte mínimo"). No Windows, o pgvector precisa ser compilado: siga <https://github.com/pgvector/pgvector#windows> e depois rode `CREATE EXTENSION vector;` no banco `nimber_atende`. Se pular este item, tudo funciona; dá para ativar depois (reinicie o serviço e reindexe os documentos).

> Na DigitalOcean o PostgreSQL gerenciado já traz pgvector.

### 2.4 Banco em outra máquina

Se o PostgreSQL estiver em outro servidor, libere o acesso do servidor do Nimber Atende em `pg_hba.conf` (ex.: `host nimber_atende nimber_atende 192.168.0.30/32 scram-sha-256`), confira `listen_addresses` em `postgresql.conf` e a porta 5432 no firewall daquela máquina.

### 2.5 Já existe um PostgreSQL com outros bancos

Não instale outro PostgreSQL. Use o servidor existente de uma destas formas:

- **Banco próprio (recomendado):** rode só os comandos do item 2.2 nesse servidor, conectado com um usuário administrador. Os bancos são isolados entre si.
- **Dentro de um banco que já existe:** crie um schema só para o Nimber Atende e aponte o `database.txt` para ele. Como administrador, dentro desse banco:

  ```sql
  CREATE ROLE nimber_atende LOGIN PASSWORD 'troque-por-uma-senha-longa';
  CREATE SCHEMA nimber_atende AUTHORIZATION nimber_atende;
  GRANT CONNECT ON DATABASE nome_do_banco_existente TO nimber_atende;
  CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;
  CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;
  ```

  No `database.txt`: `DATABASE=nome_do_banco_existente` e `SCHEMA=nimber_atende`. As 37 tabelas ficam todas nesse schema, sem tocar nas tabelas do outro sistema.

## 3. Rodar o instalador

1. Clique com o botão direito em `NimberAtendeServer-Setup-<versão>.exe` → **Executar como administrador**.
   - Se o SmartScreen avisar, clique em **Mais informações → Executar assim mesmo** (o instalador não tem assinatura digital).
2. **Pasta de instalação**: mantenha `C:\Program Files\Nimber Atende`.
3. **Banco de dados**: servidor (`localhost` se for a mesma máquina), porta `5432`, banco `nimber_atende`, usuário `nimber_atende` e a senha do passo 2.2. Marque SSL só para banco na nuvem.
4. **Painel web**: porta `8080` (troque se já estiver em uso).
5. **Instalar**. O instalador:
   - grava a configuração em `C:\ProgramData\NimberAtende\config\` e restringe a pasta a Administradores e SYSTEM;
   - protege a senha do banco com o Windows (DPAPI): no `database.txt` ela vira `PASSWORD=dpapi:…`;
   - gera a **chave mestra** (`master.key`), que cifra chaves de IA, senhas de bancos externos e o 2FA;
   - cria as tabelas, instala o serviço **Nimber Atende** (início automático) e libera a porta no firewall.
6. Ao terminar, ele abre `http://localhost:8080`.

Se aparecer "Não foi possível preparar o banco de dados agora", o serviço foi instalado do mesmo jeito. Corrija `C:\ProgramData\NimberAtende\config\database.txt` (com o Bloco de Notas como administrador) e reinicie o serviço em `services.msc`.

## 4. Primeiro acesso

1. Em `http://localhost:8080`, crie o **administrador** (nome, e-mail, senha com 10+ caracteres).
2. Configure o **2FA**: leia o QR Code com Microsoft Authenticator, Google Authenticator ou 1Password e digite o código de 6 dígitos.
3. **Guarde os códigos de recuperação** num cofre de senhas. Eles são a saída se o celular for perdido.

## 5. Guardar a chave mestra (uma vez só)

Prompt de Comando **como administrador**:

```bat
"C:\Program Files\Nimber Atende\tools\nimber-cli.cmd" export-key
```

Copie a linha mostrada para o cofre de senhas da Nimber (item "Nimber Atende — chave mestra"). Ela é necessária para restaurar um backup em outra máquina ou levar o sistema para a DigitalOcean. Sem ela, as chaves de IA e senhas de bancos externos precisam ser cadastradas de novo e cada usuário refaz o 2FA.

## 6. Configurar o atendimento

Siga nesta ordem, em **Configurações**:

| Onde | O que fazer |
|---|---|
| **Setores e horários** | Confira SDR, Closer e Suporte: horário, mensagem fora do horário e distribuição (rodízio, menos ocupado ou puxar da fila). Jurídico vem inativo. |
| **Feriados** | Os nacionais já estão cadastrados. Inclua Carnaval, Sexta-feira Santa, Corpus Christi e os municipais. |
| **Usuários** | Crie os atendentes, escolha o papel e os setores. Eles recebem uma senha temporária. |
| **Provedores e modelos** | Cadastre a chave da Anthropic (ou OpenAI/Gemini), clique em **Testar** e escolha o modelo de cada tarefa e o reserva. Transcrição de áudio e embeddings precisam de OpenAI ou Gemini. Até lá, o provedor **Simulado** permite testar sem custo. |
| **Agente de IA** | Persona, objetivo e instruções do assistente. |
| **Qualificação de leads** | Critérios, pontos e o corte que manda o lead para o Closer. Use o simulador da página. |
| **Transferência para humano** e **Compliance** | Gatilhos e travas. **O texto do disclaimer foi proposto e precisa da validação do compliance da Nimber antes do uso real.** |
| **Base de conhecimento** (menu lateral) | Envie os materiais (PDF, Word), cadastre o FAQ e teste a busca. |
| **Conexões WhatsApp** | Veja o item 7. |

## 7. Conectar o WhatsApp

1. **Configurações → Conexões WhatsApp → Nova conexão**. Dê um nome (ex.: "Comercial"), escolha o setor padrão e, se quiser, um fluxo de entrada.
2. **Conectar**. Aparece o QR Code.
3. No celular do número: **WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho** e leia o QR.
4. Em alguns segundos o status fica **Conectado**.

O número continua funcionando no celular. Quando alguém responde por lá, a IA pausa naquela conversa. Se a conexão for removida pelo celular, o painel mostra "Desconectado" (e o Slack avisa, se configurado): é só ler o QR de novo.

## 8. Acesso dos atendentes

- **Navegador**: `http://<nome-do-servidor>:8080` (ex.: `http://srv-atende:8080`). Descubra o nome com `hostname` no Prompt de Comando do servidor.
- **App desktop**: instale `NimberAtende-Desktop-Setup-<versão>.exe` em cada computador. Na primeira abertura ele pede o endereço do servidor. Ele fica na bandeja, mostra notificações do Windows e o contador de pendências na barra de tarefas. Para distribuir já configurado, veja [COMO-SUBIR-NO-GITHUB.md](COMO-SUBIR-NO-GITHUB.md#app-desktop-já-apontando-para-o-servidor).
- Ajuste `PUBLIC_URL` em `C:\ProgramData\NimberAtende\config\server.txt` para o endereço que a equipe usa e reinicie o serviço.

### HTTPS na rede interna (opcional)

Para usar `https://atende.nimber.local`, coloque um proxy reverso na frente (IIS com URL Rewrite + ARR, ou Caddy para Windows). No `server.txt`: `PUBLIC_URL=https://atende.nimber.local` e `TRUST_PROXY=true`. Com HTTPS, os cookies de sessão passam a ser marcados como `Secure`.

## 9. Backup diário

O comando `backup` usa a configuração do próprio serviço (a senha protegida não precisa ficar em lugar nenhum) e mantém só os mais recentes.

Teste uma vez (Prompt como administrador):

```bat
"C:\Program Files\Nimber Atende\tools\nimber-cli.cmd" backup --out D:\Backups\NimberAtende --keep 14
```

Agende todos os dias às 23h30, como SYSTEM:

```bat
schtasks /Create /TN "Nimber Atende - Backup" /SC DAILY /ST 23:30 /RU SYSTEM /RL HIGHEST /TR "\"C:\Program Files\Nimber Atende\tools\nimber-cli.cmd\" backup --out D:\Backups\NimberAtende --keep 14"
```

- Se o PostgreSQL estiver em outra máquina, instale nela as "Command Line Tools" do PostgreSQL ou passe `--pg-dump "C:\caminho\pg_dump.exe"` (versão igual ou maior que a do banco).
- Copie a pasta de backups para fora do servidor (OneDrive/SharePoint da Nimber, NAS).
- Restaurar: `pg_restore -h localhost -U nimber_atende -d nimber_atende --clean --if-exists arquivo.dump` com o serviço parado.

## 10. Atualizar

Rode o novo `NimberAtendeServer-Setup-<versão>.exe` como administrador. Ele para o serviço, troca o código, mantém configuração e chave, aplica as migrações e inicia de novo. As conexões de WhatsApp reconectam sozinhas (a sessão fica no banco).

## 11. Onde ficam as coisas

| O quê | Onde |
|---|---|
| Programa | `C:\Program Files\Nimber Atende\` |
| Configuração (`database.txt`, `server.txt`, `master.key`) | `C:\ProgramData\NimberAtende\config\` |
| Logs do servidor | `C:\ProgramData\NimberAtende\data\logs\servidor-AAAA-MM-DD.log` |
| Logs do serviço (início/parada) | `C:\ProgramData\NimberAtende\data\logs\servico\` |
| Serviço | `services.msc` → **Nimber Atende** |
| Linha de comando | `C:\Program Files\Nimber Atende\tools\nimber-cli.cmd` |

## 12. Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Painel não abre | `services.msc` → Nimber Atende está "Em execução"? Veja o log do dia. Rode `nimber-cli check`. |
| `check` falha com "password authentication failed" | Senha errada no `database.txt`. Escreva a senha certa em texto puro (`PASSWORD=...`) e reinicie o serviço: ela é protegida de novo. |
| "connect ECONNREFUSED" | PostgreSQL parado, porta errada ou firewall/pg_hba bloqueando. |
| Atendentes não acessam de outro computador | Firewall do Windows (regra "Nimber Atende"), antivírus ou porta errada. Teste `http://<ip-do-servidor>:8080/api/health`. |
| QR Code expira | Ele é renovado sozinho por alguns minutos. Se parar, clique em Conectar de novo. |
| Conexão cai com frequência | Confira a internet do servidor e se o mesmo número não foi conectado em outro sistema (ex.: outra ferramenta de WhatsApp). |
| Esqueci a senha do admin / perdi o 2FA | Use um código de recuperação. Sem ele: `nimber-cli reset-admin email@nimber.com.br` gera senha temporária e remove o 2FA. |
| Porta 8080 ocupada | Troque `PORT` no `server.txt`, ajuste a regra do firewall e reinicie o serviço. |

## 13. Desinstalar

**Configurações do Windows → Aplicativos → Nimber Atende (servidor) → Desinstalar**. O serviço e a regra de firewall são removidos. A configuração e a chave ficam em `C:\ProgramData\NimberAtende` e os dados continuam no PostgreSQL, para uma reinstalação futura. Para apagar tudo, remova essa pasta e o banco `nimber_atende`.

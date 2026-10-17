# Como subir o Nimber Atende para o GitHub

Este guia leva o pacote entregue até um repositório privado no GitHub, com os instaladores do Windows e a imagem Docker gerados automaticamente pelo GitHub Actions.

## O que veio no pacote

| Arquivo | Para que serve |
|---|---|
| `nimber-atende-v1.0.0-completo.zip` | **O que você sobe.** Projeto inteiro com o histórico do Git: um commit por fase (0 a 5) e as tags `fase-0` … `fase-5` e `v1.0.0`. |
| `nimber-atende-fase0.zip` … `fase5.zip` | Retratos do código ao fim de cada fase, sem histórico. Servem para revisar fase a fase; não precisa subir. |

O histórico já está organizado assim:

```
v1.0.0  fase-5  Fase 5: instaladores, app desktop, Docker, CI e documentação
        fase-4  Fase 4: integrações, consultas a outras bases, webhooks, follow-ups e relatórios
        fase-3  Fase 3: construtor visual de fluxos com simulador, versões e métricas por nó
        fase-2  Fase 2: motor de IA com qualificação híbrida, base de conhecimento e travas de compliance
        fase-1  Fase 1: servidor, conexões por QR Code, login com 2FA e caixa de entrada multiatendente
        fase-0  Fase 0: documento de arquitetura e decisões
```

---

## Passo 1 — Criar o repositório vazio no GitHub

1. Entre em <https://github.com> com a conta da Nimber.
2. Canto superior direito: **+** → **New repository**.
3. **Owner**: a organização da Nimber (ou sua conta). **Repository name**: `nimber-atende`.
4. Marque **Private**.
5. **Não** marque "Add a README", ".gitignore" nem "license" — o repositório precisa nascer vazio.
6. **Create repository**. Deixe a página aberta: ela mostra o endereço `https://github.com/<dono>/nimber-atende.git`.

## Passo 2 — Descompactar

Descompacte `nimber-atende-v1.0.0-completo.zip` numa pasta sua, por exemplo `C:\Projetos\`. Vai aparecer `C:\Projetos\nimber-atende\`.

> A pasta `.git` dentro dela é o histórico. No Explorer ela fica oculta; não apague.

## Passo 3 — Enviar (escolha um caminho)

### Caminho A — Terminal (PowerShell)

Pré-requisito: Git instalado (<https://git-scm.com/download/win>, opções padrão).

```powershell
cd C:\Projetos\nimber-atende

# confira: deve listar os 6 commits das fases
git log --oneline

# aponte para o repositório criado no passo 1 (troque <dono>)
git remote add origin https://github.com/<dono>/nimber-atende.git

# envie a branch principal e depois as tags
git push -u origin main
git push origin --tags
```

Na primeira vez, o Git abre uma janela de login do GitHub. Use a conta que tem acesso ao repositório.

### Caminho B — GitHub Desktop (sem terminal)

1. Instale o GitHub Desktop (<https://desktop.github.com>) e entre com a conta da Nimber.
2. **File → Add local repository…** → escolha `C:\Projetos\nimber-atende` → **Add repository**.
3. Clique em **Publish repository**. Desmarque "Keep this code private" **somente se** quiser público (não recomendado). Em **Organization**, escolha a da Nimber. Publique.
   - Se você já criou o repositório no passo 1 com o mesmo nome, o GitHub Desktop avisa que ele existe. Nesse caso, use o Caminho A (é só o `git remote add` e os dois `push`).
4. O GitHub Desktop não envia tags sozinho. Depois de publicar, abra **Repository → Open in Command Prompt** e rode `git push origin --tags`.

## Passo 4 — Liberar o GitHub Actions

1. No repositório: **Settings → Actions → General**.
2. Em **Actions permissions**: "Allow all actions and reusable workflows" (ou, se a organização restringir, libere as ações `actions/*`, `docker/*` e `softprops/action-gh-release`).
3. Em **Workflow permissions**: marque **Read and write permissions**. **Save**.
4. Vá em **Actions**. Se aparecer "Workflows aren't being run on this repository", clique em **I understand my workflows, go ahead and enable them**.

## Passo 5 — Gerar os instaladores e a imagem

O envio da tag `v1.0.0` no passo 3 já disparou tudo. Acompanhe em **Actions**:

| Workflow | Quando roda | Resultado |
|---|---|---|
| **CI** | Todo push na `main` e todo pull request | Verifica tipos, roda os testes, compila, aplica as migrações num PostgreSQL limpo e sobe o servidor para um teste rápido. |
| **Release (instaladores Windows)** | Toda tag `v*` | Em **Releases**: `NimberAtendeServer-Setup-1.0.0.exe` (servidor), `.sha256` e `NimberAtende-Desktop-Setup-1.0.0.exe` (app dos atendentes). |
| **Imagem Docker** | Push na `main` e tags `v*` | `ghcr.io/<dono>/nimber-atende` em **Packages**, para a DigitalOcean. |

Se o Release foi disparado antes de você liberar o Actions no passo 4, rode de novo: **Actions → Release → Run workflow** (gera os arquivos como artefatos do workflow), ou apague e reenvie a tag:

```powershell
git push origin :refs/tags/v1.0.0
git push origin v1.0.0
```

## Passo 6 — Baixar e instalar

- Servidor: **Releases → v1.0.0 → NimberAtendeServer-Setup-1.0.0.exe** → siga o [Guia de instalação no Windows](GUIA-INSTALACAO-WINDOWS.md).
- Atendentes: **NimberAtende-Desktop-Setup-1.0.0.exe** em cada computador (ou só o navegador).

Os instaladores não têm assinatura digital de código. Na primeira execução, o Windows SmartScreen pode mostrar "O Windows protegeu o computador": clique em **Mais informações → Executar assim mesmo**. Para eliminar o aviso, compre um certificado de assinatura de código e configure-o no workflow (variáveis `CSC_LINK`/`CSC_KEY_PASSWORD` do electron-builder e `signtool` no Inno Setup).

---

## Novas versões

```powershell
node scripts/set-version.mjs 1.1.0     # troca a versão em todos os package.json
npm install                             # atualiza o package-lock.json
git commit -am "Versão 1.1.0"
git tag v1.1.0
git push --follow-tags
```

O Release gera os novos instaladores. No servidor, basta rodar o novo `NimberAtendeServer-Setup` por cima: ele para o serviço, troca o código, mantém a configuração e aplica as migrações.

## App desktop já apontando para o servidor

Para que os atendentes não precisem digitar o endereço:

1. Edite `apps/desktop/server-url.txt` e escreva o endereço numa linha sem `#`, por exemplo `http://srv-atende:8080`.
2. Commit + nova tag (`v1.0.1`). O instalador desktop gerado já abre direto no servidor.

Alternativa sem gerar nova versão: crie `C:\ProgramData\NimberAtende\desktop-server.txt` com o endereço em cada máquina (dá para distribuir por GPO).

## Subir fase a fase (opcional)

Se preferir revisar cada fase antes de ela entrar no repositório, use os zips de fase num repositório novo:

```powershell
mkdir C:\Projetos\nimber-atende-revisao; cd C:\Projetos\nimber-atende-revisao
git init -b main
git remote add origin https://github.com/<dono>/nimber-atende.git

# repita para fase0, fase1, … fase5 (descompacte por cima, substituindo os arquivos)
Expand-Archive ..\nimber-atende-fase0.zip -DestinationPath . -Force
git add -A; git commit -m "Fase 0"; git tag fase-0
git push -u origin main --tags
```

Ao descompactar por cima, arquivos que uma fase removeu continuam na pasta. Antes de cada fase, apague tudo menos a pasta `.git`.

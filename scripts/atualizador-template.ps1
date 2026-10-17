<#
  Nimber Atende - atualizador __VERSAO__ com autoteste

  O que faz, nesta ordem:
    1. Confere a pasta do projeto, o Node.js e o banco de dados
    2. Encerra o servidor antigo deste projeto que estiver rodando (npm start / dev)
    3. Guarda os arquivos atuais em .\backup-antes-__VERSAO__\ e grava os corrigidos
    4. Recompila do zero (apaga apps\web\dist e apps\server\dist e roda npm run build)
    5. Sobe o servidor por alguns segundos e testa: página, scripts, cache, 404 e API
    6. Abre o painel num navegador sem interface (Edge ou Chrome) e confere se a tela de login aparece
    7. Grava tudo em .\diagnostico-nimber-atende.txt

  NÃO mexe no banco de dados, nos usuários, no 2FA nem na pasta config.

  Uso (PowerShell, na pasta do projeto):
    powershell -ExecutionPolicy Bypass -File .\atualizar-nimber-atende-__VERSAO__.ps1
  Depois:
    npm start      e abra http://localhost:8080 com Ctrl+F5
#>
param([switch]$SemTesteNavegador)

$ErrorActionPreference = 'Stop'
$IsWin = ($env:OS -eq 'Windows_NT')
$sep = [IO.Path]::DirectorySeparatorChar
$root = (Get-Location).Path
$script:rep = New-Object System.Collections.Generic.List[string]
$script:falhas = 0

function Rep([string]$s) { $script:rep.Add($s) | Out-Null }
function Titulo([string]$s) { Write-Host ''; Write-Host "== $s" -ForegroundColor Cyan; Rep ''; Rep "== $s" }
function Ok([string]$s) { Write-Host "  [ok]    $s" -ForegroundColor Green; Rep "  [ok]    $s" }
function Aviso([string]$s) { Write-Host "  [aviso] $s" -ForegroundColor Yellow; Rep "  [aviso] $s" }
function Falha([string]$s) { Write-Host "  [FALHA] $s" -ForegroundColor Red; Rep "  [FALHA] $s"; $script:falhas++ }
function Info([string]$s) { Write-Host "          $s"; Rep "          $s" }
function P([string]$rel) { return (Join-Path $root ($rel -replace '\\', $sep)) }

function Run-Captura([string]$exe, [string[]]$argumentos, [int]$timeoutMs = 120000) {
  $o = [IO.Path]::GetTempFileName(); $e = [IO.Path]::GetTempFileName()
  $sp = @{ FilePath = $exe; ArgumentList = $argumentos; WorkingDirectory = $root; RedirectStandardOutput = $o; RedirectStandardError = $e; PassThru = $true }
  $sp.NoNewWindow = $true
  $pr = Start-Process @sp
  $null = $pr.Handle  # necessário no Windows PowerShell 5.1 para ler o ExitCode depois
  if (-not $pr.WaitForExit($timeoutMs)) { try { Stop-Process -Id $pr.Id -Force } catch {} }
  $saida = ((Get-Content $o -Raw -Encoding UTF8) + "`n" + (Get-Content $e -Raw -Encoding UTF8)).Trim()
  Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
  return [pscustomobject]@{ Code = $pr.ExitCode; Out = $saida }
}

Add-Type -AssemblyName System.Net.Http
$script:http = New-Object System.Net.Http.HttpClient
$script:http.Timeout = [TimeSpan]::FromSeconds(10)
function Get-Http([string]$url) {
  try {
    $r = $script:http.GetAsync($url).GetAwaiter().GetResult()
    $b = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $ct = ''; if ($r.Content.Headers.ContentType) { $ct = $r.Content.Headers.ContentType.ToString() }
    $cc = ''; if ($r.Headers.CacheControl) { $cc = $r.Headers.CacheControl.ToString() }
    return [pscustomobject]@{ Status = [int]$r.StatusCode; Type = $ct; Cache = $cc; Body = $b }
  } catch {
    return [pscustomobject]@{ Status = 0; Type = ''; Cache = ''; Body = $_.Exception.Message }
  }
}

Write-Host "Nimber Atende - atualizador __VERSAO__" -ForegroundColor Cyan
Rep "Nimber Atende - diagnóstico do atualizador __VERSAO__ - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Rep "Pasta: $root"

# ---------------------------------------------------------------- 1. ambiente
Titulo 'Ambiente'
if (-not (Test-Path (P 'apps\server\package.json')) -or -not (Test-Path (P 'apps\web\package.json'))) {
  Falha 'Esta não é a pasta do projeto. Rode: cd C:\Projetos\nimber-atende  e depois o script de novo.'
  exit 1
}
Ok "Pasta do projeto: $root"
$npm = 'npm'; if ($IsWin) { $npm = 'npm.cmd' }
try { $nodeV = (& node -v).Trim() } catch { Falha 'Node.js não encontrado no PATH. Instale o Node.js 22 LTS.'; exit 1 }
$major = [int]($nodeV.TrimStart('v').Split('.')[0])
if ($major -lt 22) { Falha "Node.js $nodeV é antigo. Instale o Node.js 22 LTS."; exit 1 }
Ok "Node.js $nodeV"
if ($IsWin) { Info ("Windows: " + [Environment]::OSVersion.VersionString) }
if (-not (Test-Path (P 'node_modules'))) { Falha 'Faltam as dependências. Rode npm install antes.'; exit 1 }

$porta = 8080
if ($env:PORT) { $porta = [int]$env:PORT }
$srvTxt = P 'config\server.txt'
if (Test-Path $srvTxt) {
  foreach ($l in (Get-Content $srvTxt -Encoding UTF8)) { if ($l -match '^\s*PORT\s*=\s*(\d+)') { $porta = [int]$Matches[1] } }
}
Ok "Porta do painel: $porta"
$dbTxt = P 'config\database.txt'
if (Test-Path $dbTxt) {
  $resumo = (Get-Content $dbTxt -Encoding UTF8 | Where-Object { $_ -match '^\s*(HOST|PORT|DATABASE|USER|SCHEMA|SSL)\s*=' }) -join '  '
  Info "Banco (database.txt): $resumo"
} else { Aviso 'config\database.txt não existe (crie a partir de database.example.txt).' }

# ---------------------------------------------------------------- 2. servidor antigo
Titulo 'Servidor em execução'
$parados = 0
if ($IsWin) {
  $donos = @()
  try { $donos = @(Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch {}
  foreach ($procId in $donos) {
    $pi = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    $cmd = ''; if ($pi) { $cmd = [string]$pi.CommandLine }
    if ($pi -and $pi.Name -eq 'node.exe' -and $cmd -match '(dist[\\/]index\.js|src[\\/]index\.ts)') {
      Stop-Process -Id $procId -Force; $parados++
      Ok "Servidor antigo encerrado (PID $procId): $cmd"
    } elseif ($pi) {
      Falha "A porta $porta está ocupada por outro programa: $($pi.Name) (PID $procId) $cmd"
      Info "Feche esse programa ou troque PORT em config\server.txt."
    }
  }
  # npm start / npm run dev deste projeto que ainda estejam vivos
  $restos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'tsx.*watch.*src[\\/]index\.ts' }
  foreach ($r in $restos) { Stop-Process -Id $r.ProcessId -Force -ErrorAction SilentlyContinue; $parados++; Ok "Modo dev antigo encerrado (PID $($r.ProcessId))" }
  if ($parados -gt 0) { Start-Sleep -Seconds 2 }
}
if ($parados -eq 0) { Ok 'Nenhum servidor do projeto estava rodando nesta porta.' }
$antes = Get-Http "http://localhost:$porta/api/health"
if ($antes.Status -ne 0) { Falha "Ainda há algo respondendo em http://localhost:$porta. Feche a janela do npm start (Ctrl+C) e rode o script de novo."; exit 1 }

# ---------------------------------------------------------------- 3. arquivos
Titulo 'Arquivos corrigidos'
$arquivos = [ordered]@{
__ARQUIVOS__
}
$backup = P 'backup-antes-__VERSAO__'
foreach ($rel in $arquivos.Keys) {
  $dest = P $rel
  if (Test-Path $dest) {
    $bk = Join-Path $backup ($rel -replace '\\', $sep)
    New-Item -ItemType Directory -Force -Path (Split-Path $bk) | Out-Null
    Copy-Item $dest $bk -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($arquivos[$rel]))
}
Ok "$($arquivos.Count) arquivos gravados (cópia dos anteriores em backup-antes-__VERSAO__)"

# ---------------------------------------------------------------- 4. compilação
Titulo 'Compilação do zero'
foreach ($d in @('apps\web\dist', 'apps\server\dist')) { $full = P $d; if (Test-Path $full) { Remove-Item $full -Recurse -Force } }
& $npm run build
if ($LASTEXITCODE -ne 0) { Falha 'npm run build falhou (veja as mensagens acima). Os arquivos anteriores estão em backup-antes-__VERSAO__.'; $script:rep | Out-File (P 'diagnostico-nimber-atende.txt') -Encoding utf8; exit 1 }
$idx = P 'apps\web\dist\index.html'
if (-not (Test-Path $idx)) { Falha 'apps\web\dist\index.html não foi gerado.'; exit 1 }
$html = Get-Content $idx -Raw -Encoding UTF8
$refs = [regex]::Matches($html, '(?:src|href)="(/[^"]+\.(?:js|css))"') | ForEach-Object { $_.Groups[1].Value }
foreach ($ref in $refs) {
  if (Test-Path (P ('apps\web\dist' + ($ref -replace '/', '\')))) { Ok "Gerado: $ref" } else { Falha "index.html aponta para $ref, que não existe em apps\web\dist" }
}
if (-not ($html -match 'boot\.js')) { Falha 'index.html sem o vigia de carregamento (boot.js).' }

# ---------------------------------------------------------------- 5. servidor de teste
Titulo 'Servidor de teste'
$tmp = P '.diagnostico'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$chk = Run-Captura 'node' @('apps/server/dist/cli.js', 'check') 60000
if ($chk.Code -eq 0) { Ok 'Banco de dados: conexão OK' } else { Falha 'Banco de dados: a conexão falhou' }
foreach ($l in ($chk.Out -split "`n")) { if ($l.Trim()) { Info $l.Trim() } }

$logOut = Join-Path $tmp 'servidor.log'; $logErr = Join-Path $tmp 'servidor-erros.log'
$sp = @{ FilePath = 'node'; ArgumentList = @('apps/server/dist/index.js'); WorkingDirectory = $root; RedirectStandardOutput = $logOut; RedirectStandardError = $logErr; PassThru = $true }
$sp.NoNewWindow = $true
$env:PORT = "$porta"
$srv = Start-Process @sp
$base = "http://localhost:$porta"
$no_ar = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if ($srv.HasExited) { break }
  if ((Get-Http "$base/api/health").Status -eq 200) { $no_ar = $true; break }
}
if (-not $no_ar) {
  Falha 'O servidor não subiu. Últimas linhas do log:'
  foreach ($f in @($logOut, $logErr)) { if (Test-Path $f) { Get-Content $f -Tail 15 -Encoding UTF8 | ForEach-Object { Info $_ } } }
} else {
  Ok "Servidor respondeu em $base"

  # ------------------------------------------------------------ 6. HTTP
  Titulo 'Testes HTTP'
  $r = Get-Http "$base/"
  if ($r.Status -eq 200 -and $r.Type -like 'text/html*' -and $r.Body -match '<div id="root">') { Ok "Página: HTTP 200, $($r.Type)" } else { Falha "Página: HTTP $($r.Status), $($r.Type)" }
  if ($r.Cache -match 'no-cache') { Ok "Página sem cache antigo ($($r.Cache))" } else { Falha "Página com cache: '$($r.Cache)' (deveria ser no-cache)" }
  $boot = Get-Http "$base/boot.js"
  if ($boot.Status -eq 200 -and $boot.Type -match 'javascript') { Ok 'Vigia de carregamento (boot.js) OK' } else { Falha "boot.js: HTTP $($boot.Status), $($boot.Type)" }
  foreach ($ref in $refs) {
    $a = Get-Http "$base$ref"
    $tipoOk = ($ref.EndsWith('.js') -and $a.Type -match 'javascript') -or ($ref.EndsWith('.css') -and $a.Type -match 'text/css')
    if ($a.Status -eq 200 -and $tipoOk) { Ok "$ref -> HTTP 200, $($a.Type)" } else { Falha "$ref -> HTTP $($a.Status), $($a.Type) (esperado JavaScript/CSS)" }
  }
  $nf = Get-Http "$base/assets/arquivo-que-nao-existe.js"
  if ($nf.Status -eq 404) { Ok 'Arquivo inexistente responde 404' } else { Falha "Arquivo inexistente respondeu HTTP $($nf.Status) ($($nf.Type))" }
  $st = Get-Http "$base/api/setup/status"
  if ($st.Status -eq 200) { Ok "API: $($st.Body)" } else { Falha "API /api/setup/status: HTTP $($st.Status) $($st.Body)" }

  # ------------------------------------------------------------ 7. navegador
  Titulo 'Teste no navegador (sem interface)'
  $nav = $null
  if ($env:NIMBER_BROWSER -and (Test-Path $env:NIMBER_BROWSER)) { $nav = $env:NIMBER_BROWSER }
  if (-not $nav) {
    $cands = @()
    foreach ($b in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) { if ($b) { $cands += (Join-Path $b 'Microsoft\Edge\Application\msedge.exe'); $cands += (Join-Path $b 'Google\Chrome\Application\chrome.exe') } }
    if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe') }
    foreach ($c in $cands) { if (Test-Path $c) { $nav = $c; break } }
  }
  if ($SemTesteNavegador) {
    Aviso 'Teste no navegador pulado (-SemTesteNavegador).'
  } elseif (-not $nav) {
    Aviso 'Edge/Chrome não encontrado; teste no navegador pulado.'
  } else {
    Info "Navegador: $nav"
    $perfil = Join-Path $tmp 'perfil'
    $domFile = Join-Path $tmp 'tela.html'; $conFile = Join-Path $tmp 'console.log'
    $navArgs = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', "--user-data-dir=`"$perfil`"", '--enable-logging=stderr', '--v=0', '--virtual-time-budget=25000', '--dump-dom', "$base/")
    if (-not $IsWin) { $navArgs = @('--no-sandbox') + $navArgs }
    $bp = @{ FilePath = $nav; ArgumentList = $navArgs; RedirectStandardOutput = $domFile; RedirectStandardError = $conFile; PassThru = $true }
    $bp.NoNewWindow = $true
    $bpr = Start-Process @bp
    if (-not $bpr.WaitForExit(90000)) { try { Stop-Process -Id $bpr.Id -Force } catch {}; Aviso 'O navegador não terminou em 90 s.' }
    $dom = ''; if (Test-Path $domFile) { $dom = Get-Content $domFile -Raw -Encoding UTF8 }
    if (-not $dom) { $dom = '' }
    $textoTela = ($dom -replace '(?s)<script.*?</script>', '' -replace '(?s)<style.*?</style>', '' -replace '<[^>]+>', ' ' -replace '\s+', ' ').Trim()
    if ($dom -match 'O painel n.o carregou|O painel parou') {
      Falha 'O painel não abriu no navegador. Motivo mostrado na tela:'
      Info ($textoTela.Substring(0, [Math]::Min(1200, $textoTela.Length)))
    } elseif ($dom -match 'Esta tela n.o abriu') {
      Falha 'O painel abriu mas uma tela deu erro:'
      Info ($textoTela.Substring(0, [Math]::Min(1200, $textoTela.Length)))
    } elseif ($dom -match 'Entrar|Criar conta|Configura..o inicial|Atendimento|Ative a verifica') {
      Ok 'O painel abriu no navegador (tela de entrada exibida).'
    } elseif ($dom -match '<div id="root"></div>') {
      Falha 'O navegador recebeu a página, mas o painel não montou (tela em branco).'
    } else {
      Aviso "Resultado inesperado: $($textoTela.Substring(0, [Math]::Min(300, $textoTela.Length)))"
    }
    if (Test-Path $conFile) {
      $linhas = Get-Content $conFile -Encoding UTF8 | Where-Object { $_ -match 'CONSOLE|Uncaught|Failed to load|MIME|Refused' } | Select-Object -First 15
      foreach ($l in $linhas) { Info ("console: " + ($l -replace '^.*?\] ', '')) }
    }
  }
}

if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
Remove-Item Env:PORT -ErrorAction SilentlyContinue
if (Test-Path $logErr) { $erros = Get-Content $logErr -Encoding UTF8 | Where-Object { $_.Trim() } | Select-Object -First 10; if ($erros) { Rep ''; Rep '== Erros do servidor de teste'; $erros | ForEach-Object { Rep "  $_" } } }

# ---------------------------------------------------------------- resumo
$relatorio = P 'diagnostico-nimber-atende.txt'
$script:rep | Out-File $relatorio -Encoding utf8
Write-Host ''
if ($script:falhas -eq 0) {
  Write-Host "Pronto: Nimber Atende __VERSAO__ instalado e testado." -ForegroundColor Green
  Write-Host "Agora rode:  npm start" -ForegroundColor Green
  Write-Host "e abra http://localhost:$porta apertando Ctrl+F5 (recarrega sem cache)."
} else {
  Write-Host "Terminou com $($script:falhas) falha(s). Veja acima ou no arquivo:" -ForegroundColor Red
  Write-Host "  $relatorio"
  Write-Host "Envie esse arquivo para a equipe de tecnologia."
}

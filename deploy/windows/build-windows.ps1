<#
  Gera o instalador do SERVIDOR para Windows:  release\NimberAtendeServer-Setup-<versão>.exe

  Pré-requisitos na máquina de build (Windows 10/11 ou Windows Server, x64):
    - Node.js 22 e Git no PATH
    - Inno Setup 6 (https://jrsoftware.org/isdl.php)  — ou deixe o script instalar via winget/choco
    - Internet (baixa o Node.js portátil e o WinSW)

  Uso (PowerShell, na raiz do repositório):
    powershell -ExecutionPolicy Bypass -File deploy\windows\build-windows.ps1
    powershell -ExecutionPolicy Bypass -File deploy\windows\build-windows.ps1 -SkipBuild   # reaproveita o build
#>
param(
  [switch]$SkipBuild,
  [string]$NodeMajor = "22",
  [string]$WinSWVersion = "v2.12.0"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root
$Out = Join-Path $Root "out"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$env:NIMBER_VERSION = $Version
Write-Host "Nimber Atende $Version"

if (-not $SkipBuild) {
  Step "Instalando dependências (npm ci)"
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci falhou" }
  Step "Compilando web e servidor"
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "build falhou" }
}

Step "Montando o pacote do servidor (dependências de produção para Windows)"
node scripts/package-server.mjs
if ($LASTEXITCODE -ne 0) { throw "package-server falhou" }

Step "Baixando o Node.js $NodeMajor portátil (win-x64) e conferindo o SHA-256"
$NodeBase = "https://nodejs.org/dist/latest-v$NodeMajor.x"
$Sums = (Invoke-WebRequest "$NodeBase/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
$Line = $Sums | Where-Object { $_ -match "node-v[\d\.]+-win-x64\.zip$" } | Select-Object -First 1
if (-not $Line) { throw "Não encontrei o pacote win-x64 em $NodeBase" }
$Hash, $ZipName = ($Line.Trim() -split "\s+")
$Zip = Join-Path $Out $ZipName
if (-not (Test-Path $Zip)) { Invoke-WebRequest "$NodeBase/$ZipName" -OutFile $Zip -UseBasicParsing }
$Actual = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
if ($Actual -ne $Hash.ToLower()) { Remove-Item $Zip; throw "SHA-256 do Node.js não confere ($Actual <> $Hash)" }
$NodeDir = Join-Path $Out "node"
if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
$Tmp = Join-Path $Out "node-tmp"
if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
Expand-Archive $Zip -DestinationPath $Tmp
Move-Item (Get-ChildItem $Tmp -Directory | Select-Object -First 1).FullName $NodeDir
Remove-Item $Tmp -Recurse -Force
# O servidor só precisa do node.exe (npm/corepack ficam de fora para reduzir o instalador)
Get-ChildItem $NodeDir -Exclude "node.exe","LICENSE" | Remove-Item -Recurse -Force
Write-Host "Node.js: $ZipName"

Step "Baixando o WinSW $WinSWVersion (gerenciador do serviço do Windows)"
$WinSWDir = Join-Path $Out "winsw"
New-Item -ItemType Directory -Force -Path $WinSWDir | Out-Null
$WinSW = Join-Path $WinSWDir "WinSW-x64.exe"
if (-not (Test-Path $WinSW)) {
  Invoke-WebRequest "https://github.com/winsw/winsw/releases/download/$WinSWVersion/WinSW-x64.exe" -OutFile $WinSW -UseBasicParsing
}

Step "Localizando o Inno Setup"
$Iscc = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Iscc) {
  Write-Host "Inno Setup não encontrado. Tentando instalar…"
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id JRSoftware.InnoSetup -e --silent --accept-package-agreements --accept-source-agreements
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    choco install innosetup -y --no-progress
  } else {
    throw "Instale o Inno Setup 6 (https://jrsoftware.org/isdl.php) e rode de novo."
  }
  $Iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}

Step "Compilando o instalador"
& $Iscc /Qp (Join-Path $PSScriptRoot "NimberAtende.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC falhou" }

$Setup = Join-Path $Root "release\NimberAtendeServer-Setup-$Version.exe"
$Sha = (Get-FileHash $Setup -Algorithm SHA256).Hash.ToLower()
"$Sha  NimberAtendeServer-Setup-$Version.exe" | Out-File -Encoding ascii "$Setup.sha256"
Write-Host "`nPronto: $Setup" -ForegroundColor Green
Write-Host "SHA-256: $Sha"

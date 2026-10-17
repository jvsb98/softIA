@echo off
rem Linha de comando de manutenção do Nimber Atende.
rem Exemplos (Prompt de Comando como administrador):
rem   nimber-cli check            testa a conexão com o banco
rem   nimber-cli migrate          aplica migrações pendentes
rem   nimber-cli reset-admin      redefine a senha e o 2FA de um administrador
rem   nimber-cli export-key       mostra a chave mestra (para migrar de servidor)
rem   nimber-cli import-key KEY   grava a chave mestra vinda de outro servidor
rem   nimber-cli backup --out D:\Backups\NimberAtende --keep 14   copia o banco (pg_dump)
if "%NIMBER_CONFIG_DIR%"=="" set "NIMBER_CONFIG_DIR=%ProgramData%\NimberAtende\config"
"%~dp0..\node\node.exe" "%~dp0..\server\dist\cli.js" %*

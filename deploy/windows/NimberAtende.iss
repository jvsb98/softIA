; =====================================================================
;  Nimber Atende — instalador do SERVIDOR para Windows (Inno Setup 6)
; =====================================================================
;  Gerado por deploy/windows/build-windows.ps1 (ou pelo GitHub Actions).
;  O que o instalador faz:
;    1. Copia o servidor, o Node.js portátil e o WinSW para C:\Program Files\Nimber Atende
;    2. Pergunta os dados do PostgreSQL e grava C:\ProgramData\NimberAtende\config\database.txt
;       (na atualização, mantém a configuração existente e não pergunta de novo)
;    3. Restringe a pasta de configuração a Administradores e SYSTEM
;    4. Aplica as migrações do banco
;    5. Instala e inicia o serviço do Windows "Nimber Atende" (início automático)
;    6. Libera a porta do painel no Firewall do Windows
; =====================================================================

#define AppVersion GetEnv("NIMBER_VERSION")
#if AppVersion == ""
  #undef AppVersion
  #define AppVersion "1.0.0"
#endif
#define PkgRoot "..\..\out\nimber-atende"
#define NodeDir "..\..\out\node"
#define WinSWExe "..\..\out\winsw\WinSW-x64.exe"

[Setup]
AppId={{8E3B5C1A-4F2D-4B7E-9C61-2A5D7E9F1B34}
AppName=Nimber Atende (servidor)
AppVersion={#AppVersion}
AppVerName=Nimber Atende {#AppVersion} (servidor)
AppPublisher=Nimber
AppPublisherURL=https://nimber.com.br
DefaultDirName={autopf}\Nimber Atende
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\..\release
OutputBaseFilename=NimberAtendeServer-Setup-{#AppVersion}
SetupIconFile=nimber.ico
UninstallDisplayIcon={app}\nimber.ico
UninstallDisplayName=Nimber Atende (servidor)
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[InstallDelete]
; Atualização limpa do código (configuração e dados ficam em ProgramData e não são tocados)
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\node"

[Dirs]
Name: "{commonappdata}\NimberAtende\config"; Flags: uninsneveruninstall
Name: "{commonappdata}\NimberAtende\data"; Flags: uninsneveruninstall
Name: "{autoprograms}\Nimber Atende"

[Files]
Source: "{#PkgRoot}\server\*"; DestDir: "{app}\server"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#NodeDir}\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#WinSWExe}"; DestDir: "{app}"; DestName: "NimberAtende.exe"; Flags: ignoreversion
Source: "NimberAtende.xml"; DestDir: "{app}"; Flags: ignoreversion
Source: "nimber.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "tools\*"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "{#PkgRoot}\config-exemplo\*"; DestDir: "{app}\config-exemplo"; Flags: ignoreversion

[INI]
Filename: "{autoprograms}\Nimber Atende\Abrir o Nimber Atende.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:GetPort}/"
Filename: "{autoprograms}\Nimber Atende\Abrir o Nimber Atende.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\nimber.ico"
Filename: "{autoprograms}\Nimber Atende\Abrir o Nimber Atende.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{autoprograms}\Nimber Atende\Configuração do servidor"; Filename: "{commonappdata}\NimberAtende\config"
Name: "{autoprograms}\Nimber Atende\Logs do servidor"; Filename: "{commonappdata}\NimberAtende\data\logs"

[UninstallDelete]
Type: files; Name: "{autoprograms}\Nimber Atende\Abrir o Nimber Atende.url"

[Run]
Filename: "http://localhost:{code:GetPort}/"; Description: "Abrir o Nimber Atende no navegador"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\NimberAtende.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\NimberAtende.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Nimber Atende"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFirewall"

[Code]
var
  DbPage: TInputQueryWizardPage;
  SrvPage: TInputQueryWizardPage;
  SslBox: TNewCheckBox;
  HasConfig: Boolean;

function ConfigDir: String;
begin
  Result := ExpandConstant('{commonappdata}\NimberAtende\config');
end;

{ Lê KEY=VALOR de um arquivo de configuração (ignora comentários). }
function ReadKey(const FileName, Key, Default: String): String;
var
  Lines: TArrayOfString;
  I, P: Integer;
  L: String;
begin
  Result := Default;
  if not LoadStringsFromFile(FileName, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    L := Trim(Lines[I]);
    if (L = '') or (L[1] = '#') or (L[1] = ';') then Continue;
    P := Pos('=', L);
    if (P > 1) and (CompareText(Trim(Copy(L, 1, P - 1)), Key) = 0) then
    begin
      Result := Trim(Copy(L, P + 1, Length(L)));
      Exit;
    end;
  end;
end;

function GetPort(Param: String): String;
begin
  if HasConfig or (SrvPage = nil) then
    Result := ReadKey(ConfigDir + '\server.txt', 'PORT', '8080')
  else
    Result := Trim(SrvPage.Values[0]);
  if Result = '' then Result := '8080';
end;

procedure InitializeWizard;
begin
  HasConfig := FileExists(ConfigDir + '\database.txt');

  DbPage := CreateInputQueryPage(wpSelectDir,
    'Banco de dados',
    'Onde fica o PostgreSQL do Nimber Atende?',
    'Use um banco PostgreSQL 14 ou mais recente, já criado (vazio ou de uma instalação anterior). ' +
    'O usuário precisa ser o dono do banco. A senha fica protegida pelo Windows (DPAPI) e não aparece em texto puro.');
  DbPage.Add('Servidor (nome ou IP):', False);
  DbPage.Add('Porta:', False);
  DbPage.Add('Nome do banco:', False);
  DbPage.Add('Usuário:', False);
  DbPage.Add('Senha:', True);
  DbPage.Values[0] := 'localhost';
  DbPage.Values[1] := '5432';
  DbPage.Values[2] := 'nimber_atende';
  DbPage.Values[3] := 'nimber_atende';

  SslBox := TNewCheckBox.Create(DbPage);
  SslBox.Parent := DbPage.Surface;
  SslBox.Top := DbPage.Edits[4].Top + DbPage.Edits[4].Height + ScaleY(12);
  SslBox.Width := DbPage.SurfaceWidth;
  SslBox.Height := ScaleY(17);
  SslBox.Caption := 'Conexão com SSL (necessário em bancos na nuvem)';

  SrvPage := CreateInputQueryPage(DbPage.ID,
    'Painel web',
    'Em qual porta o painel vai responder?',
    'Os atendentes acessam pelo navegador ou pelo app desktop em http://<nome-deste-computador>:<porta>. ' +
    'A porta será liberada no Firewall do Windows.');
  SrvPage.Add('Porta HTTP:', False);
  SrvPage.Values[0] := '8080';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := HasConfig and ((PageID = DbPage.ID) or (PageID = SrvPage.ID));
end;

function IsPort(const S: String): Boolean;
var
  N: Integer;
begin
  N := StrToIntDef(Trim(S), -1);
  Result := (N > 0) and (N < 65536);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  I: Integer;
begin
  Result := True;
  if CurPageID = DbPage.ID then
  begin
    for I := 0 to 4 do
      if Trim(DbPage.Values[I]) = '' then
      begin
        MsgBox('Preencha todos os campos do banco de dados.', mbError, MB_OK);
        Result := False;
        Exit;
      end;
    if not IsPort(DbPage.Values[1]) then
    begin
      MsgBox('A porta do PostgreSQL deve ser um número entre 1 e 65535.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = SrvPage.ID then
  begin
    if not IsPort(SrvPage.Values[0]) then
    begin
      MsgBox('A porta HTTP deve ser um número entre 1 e 65535.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function RunHidden(const Exe, Params: String): Integer;
var
  Code: Integer;
begin
  if not Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then Code := -1;
  Result := Code;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Svc: String;
begin
  Result := '';
  Svc := ExpandConstant('{app}\NimberAtende.exe');
  if FileExists(Svc) then
  begin
    WizardForm.PreparingLabel.Caption := 'Parando o serviço Nimber Atende…';
    RunHidden(Svc, 'stop');
  end;
end;

procedure WriteConfig;
var
  Db: TArrayOfString;
  Srv: TArrayOfString;
  Ssl: String;
begin
  if SslBox.Checked then Ssl := 'true' else Ssl := 'false';
  SetArrayLength(Db, 14);
  Db[0] := '# Nimber Atende — conexão com o PostgreSQL (gerado pelo instalador)';
  Db[1] := '# Para trocar a senha, escreva a nova em texto puro e reinicie o serviço "Nimber Atende".';
  Db[2] := '# Ela volta a ser protegida (dpapi:...) automaticamente.';
  Db[3] := '';
  Db[4] := 'HOST=' + Trim(DbPage.Values[0]);
  Db[5] := 'PORT=' + Trim(DbPage.Values[1]);
  Db[6] := 'DATABASE=' + Trim(DbPage.Values[2]);
  Db[7] := 'USER=' + Trim(DbPage.Values[3]);
  Db[8] := 'PASSWORD=' + DbPage.Values[4];
  Db[9] := '';
  Db[10] := '# SSL: false | true | no-verify   ·   SSL_CA=arquivo.crt (na mesma pasta)';
  Db[11] := 'SSL=' + Ssl;
  Db[12] := 'POOL_MAX=15';
  Db[13] := 'SCHEMA=public';
  SaveStringsToUTF8File(ConfigDir + '\database.txt', Db, False);

  if not FileExists(ConfigDir + '\server.txt') then
  begin
    SetArrayLength(Srv, 8);
    Srv[0] := '# Nimber Atende — servidor web (gerado pelo instalador)';
    Srv[1] := 'PORT=' + Trim(SrvPage.Values[0]);
    Srv[2] := 'HOST=0.0.0.0';
    Srv[3] := '# Endereço que os atendentes usam (aparece em links). Ex.: http://atendimento.nimber.local:8080';
    Srv[4] := 'PUBLIC_URL=http://localhost:' + Trim(SrvPage.Values[0]);
    Srv[5] := '# true quando houver um proxy reverso (IIS, Caddy, Nginx) na frente';
    Srv[6] := 'TRUST_PROXY=false';
    Srv[7] := 'LOG_LEVEL=info';
    SaveStringsToUTF8File(ConfigDir + '\server.txt', Srv, False);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  App, Svc, LogFile, Port: String;
  Output: AnsiString;
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  App := ExpandConstant('{app}');
  Svc := App + '\NimberAtende.exe';
  LogFile := ExpandConstant('{tmp}\migrate.log');

  if not HasConfig then WriteConfig;

  { Configuração (senha do banco e chave mestra) só para Administradores e SYSTEM }
  WizardForm.StatusLabel.Caption := 'Protegendo a pasta de configuração…';
  RunHidden(ExpandConstant('{sys}\icacls.exe'),
    '"' + ConfigDir + '" /inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F *S-1-5-18:(OI)(CI)F');

  { Migrações (também protege a senha com DPAPI e gera a chave mestra na primeira vez) }
  WizardForm.StatusLabel.Caption := 'Preparando o banco de dados…';
  Code := RunHidden(ExpandConstant('{cmd}'),
    '/c ""' + App + '\tools\nimber-cli.cmd" migrate > "' + LogFile + '" 2>&1"');
  if Code <> 0 then
  begin
    LoadStringFromFile(LogFile, Output);
    if not WizardSilent then
      MsgBox('Não foi possível preparar o banco de dados agora:' + #13#10#13#10 + String(Output) + #13#10 +
        'O serviço será instalado mesmo assim e tentará de novo sozinho. Corrija o arquivo' + #13#10 +
        ConfigDir + '\database.txt' + #13#10 + 'e reinicie o serviço "Nimber Atende" (services.msc).', mbError, MB_OK);
  end;

  { Serviço do Windows }
  WizardForm.StatusLabel.Caption := 'Instalando o serviço Nimber Atende…';
  if RunHidden(ExpandConstant('{sys}\sc.exe'), 'query NimberAtende') <> 0 then
    RunHidden(Svc, 'install');
  RunHidden(Svc, 'start');

  { Firewall }
  Port := GetPort('');
  RunHidden(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Nimber Atende"');
  RunHidden(ExpandConstant('{sys}\netsh.exe'),
    'advfirewall firewall add rule name="Nimber Atende" dir=in action=allow protocol=TCP localport=' + Port);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    MsgBox('O Nimber Atende foi removido.' + #13#10#13#10 +
      'A configuração, a chave mestra e os logs foram mantidos em' + #13#10 +
      ExpandConstant('{commonappdata}\NimberAtende') + #13#10 +
      'e os dados continuam no PostgreSQL. Para reinstalar depois, basta rodar o instalador de novo.', mbInformation, MB_OK);
end;

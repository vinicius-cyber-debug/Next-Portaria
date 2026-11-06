[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ExternalBackupPath,
 [Parameter(Mandatory)][string]$RecoveryKeyDirectory,
 [Parameter(Mandatory)][string]$PostgresBin,
 [Parameter(Mandatory)][string]$CertificatePath,
 [Parameter(Mandatory)][string]$PrivateKeyPath,
 [string]$NodePath=(Get-Command node.exe -ErrorAction Stop).Source,
 [string]$InstallRoot='C:\NextPortaria-Instalacao',
 [string]$DataRoot='C:\NextPortaria-Dados',
 [string]$HostIP='192.168.0.2',
 [string]$Subnet='192.168.0.0/24',
 [int]$Port=8443,[int]$UiPort=5180,[int]$PostgresPort=55432,
 [string]$LegacySqlite,[string]$LegacyStateRoot,
 [switch]$PreflightOnly
)
$ErrorActionPreference='Stop'
function Run-Node([string[]]$Arguments){ & $NodePath @Arguments; if($LASTEXITCODE -ne 0){throw 'Comando Node falhou; ativacao interrompida.'} }
function Set-PrivateAcl([string]$Path,[string[]]$Extra=@()){
 & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' @Extra | Out-Null
 if($LASTEXITCODE -ne 0){throw "Nao foi possivel proteger $Path"}
}
function Save-Json($Value,[string]$Path){$utf8=New-Object System.Text.UTF8Encoding($false);[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 12),$utf8)}
function Check-Share([string]$Path){
 if(!$Path.StartsWith('\\') -or !(Test-Path -LiteralPath $Path -PathType Container)){throw 'Informe uma pasta UNC externa existente e acessivel.'}
 $hostName=$Path.TrimStart('\').Split('\')[0]
 if($hostName -in @('localhost','127.0.0.1',$env:COMPUTERNAME,$HostIP)){throw 'O destino de backup deve estar fora deste servidor.'}
 $probe=Join-Path $Path ('probe-'+[guid]::NewGuid().ToString()+'.tmp')
 [IO.File]::WriteAllText($probe,'Next Portaria backup probe');Remove-Item -LiteralPath $probe
}
if(!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Execute em PowerShell como administrador.'}
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot);$DataRoot=[IO.Path]::GetFullPath($DataRoot)
if($InstallRoot.Length -gt 100 -or $DataRoot.Length -gt 100 -or $DataRoot.Equals($InstallRoot,[StringComparison]::OrdinalIgnoreCase) -or $DataRoot.StartsWith($InstallRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $InstallRoot.StartsWith($DataRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Use pastas curtas e separe codigo e dados.'}
foreach($target in @($InstallRoot,$DataRoot)){if($target.TrimEnd('\') -eq [IO.Path]::GetPathRoot($target).TrimEnd('\') -or $target -in @($env:SystemRoot,$env:ProgramFiles,$env:ProgramData,(Join-Path $env:SystemDrive 'Users'))){throw 'Use uma pasta propria do Next Portaria, fora das raizes de sistema.'}}
& (Join-Path $PSScriptRoot 'VERIFICAR-SERVIDOR.ps1') -InstallRoot $InstallRoot -DataRoot $DataRoot
Check-Share $ExternalBackupPath;Check-Share $RecoveryKeyDirectory
if($RecoveryKeyDirectory.TrimEnd('\') -eq $ExternalBackupPath.TrimEnd('\')){throw 'Guarde a chave em pasta separada dos pacotes, com acesso restrito.'}
foreach($path in @($NodePath,(Join-Path $PostgresBin 'pg_ctl.exe'),$CertificatePath,$PrivateKeyPath)){if(!(Test-Path -LiteralPath $path -PathType Leaf)){throw "Arquivo necessario ausente: $path"}}
$nodeVersion=[version]((& $NodePath --version).TrimStart('v'));if($nodeVersion -lt [version]'22.13.0'){throw 'Node.js 22.13 ou superior necessario.'}
if((& (Join-Path $PostgresBin 'postgres.exe') --version) -notmatch ' 17\.'){throw 'Use PostgreSQL 17 para este pacote.'}
Run-Node -Arguments @((Join-Path $PSScriptRoot 'validate-config.mjs'),$CertificatePath,$PrivateKeyPath,$HostIP,$Subnet,"$Port","$UiPort")
if([Environment]::OSVersion.Version.Major -lt 10){throw 'Windows Server 2019 ou mais recente necessario.'}
$manifestPath=Join-Path $source 'release-manifest.json'
if(!(Test-Path -LiteralPath $manifestPath)){throw 'Use um pacote de release, com manifesto.'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach($file in $manifest.files){$target=[IO.Path]::GetFullPath((Join-Path $source $file.path));if(!$target.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256){throw 'Integridade do pacote divergente.'}}
$currentPath=Join-Path $InstallRoot 'current.json';$previous=$null
if(Test-Path -LiteralPath $currentPath){$previous=Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json}
if($previous -and $previous.dataRoot -ne $DataRoot){throw 'A atualizacao deve preservar a pasta de dados ativa.'}
if(!$previous){foreach($name in @('NextPortaria-App','NextPortaria-Backup','NextPortaria-Retencao')){if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw 'Ja existe tarefa homonima sem instalacao reconhecida.'}};if(Get-NetFirewallRule -Name 'NextPortaria-HTTPS' -ErrorAction SilentlyContinue){throw 'Regra de firewall homonima sem instalacao reconhecida.'};if(Get-Service -Name 'NextPortaria-Postgres' -ErrorAction SilentlyContinue){throw 'Servico PostgreSQL homonimo sem instalacao reconhecida.'}}
foreach($p in @($Port,$UiPort)){if(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue){throw "Porta $p ocupada. Encerre somente a instalacao anterior reconhecida antes de continuar."}}
if(!$previous -and (Test-Path -LiteralPath $DataRoot)){throw 'Pasta de dados preexistente sem current.json reconhecido. Inspecione e preserve antes de continuar.'}
if(!$previous -and !$LegacySqlite){foreach($state in @((Join-Path $InstallRoot 'app\.wrangler\state'),(Join-Path $InstallRoot '.wrangler\state'))){if((Test-Path -LiteralPath $state) -and (Get-ChildItem -LiteralPath $state -Filter '*.sqlite' -Recurse -File | Select-Object -First 1)){throw 'Banco legado encontrado. Inspecione e informe LegacySqlite e LegacyStateRoot antes de criar uma base nova.'}}}
if(!$previous -and (Get-NetTCPConnection -State Listen -LocalPort $PostgresPort -ErrorAction SilentlyContinue)){throw 'Porta PostgreSQL ocupada por outra instalacao.'}
if($LegacySqlite -and (!$LegacyStateRoot -or !(Test-Path -LiteralPath $LegacySqlite))){throw 'Informe o SQLite existente e a raiz .wrangler/state correspondente.'}
if($LegacySqlite){$LegacyStateRoot=[IO.Path]::GetFullPath($LegacyStateRoot).TrimEnd('\');if(!$LegacyStateRoot.EndsWith('\.wrangler\state',[StringComparison]::OrdinalIgnoreCase) -or !([IO.Path]::GetFullPath($LegacySqlite)).StartsWith($LegacyStateRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'O SQLite deve pertencer a raiz .wrangler\state informada.'};$legacyRoot=Split-Path (Split-Path $LegacyStateRoot -Parent) -Parent;if(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID -and $_.Name -match 'node|workerd' -and $_.CommandLine -and $_.CommandLine.Contains($legacyRoot)}){throw 'Encerre os processos da instalacao legada antes de copiar seu banco.'}}
if($PreflightOnly){Write-Host 'Preflight aprovado; nenhum servico, banco ou firewall alterado.';return}
$release=Join-Path $InstallRoot ('releases\'+$manifest.version+'-'+$manifest.commit.Substring(0,12))
if(Test-Path -LiteralPath $release){throw 'Esta release ja foi preparada. Nao sobrescrever codigo ativo.'}
New-Item -ItemType Directory -Path $release -Force | Out-Null
Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $release -Recurse
New-Item -ItemType Directory -Path (Join-Path $release '.porto-runtime') -Force | Out-Null
Push-Location -LiteralPath $release
$maintenance=New-Object Threading.Mutex($false,'Global\NextPortariaMaintenance');$ownsMaintenance=$false
try {
 if(!$maintenance.WaitOne(0)){throw 'Backup ou retencao em andamento. Aguarde antes de implantar.'};$ownsMaintenance=$true
 $npm=Join-Path (Split-Path $NodePath) 'npm.cmd'
 & $npm ci;if($LASTEXITCODE -ne 0){throw 'npm ci falhou.'}
 if($previous){
  Copy-Item -LiteralPath (Join-Path $previous.root '.porto-runtime\postgres.json') -Destination '.porto-runtime\postgres.json'
  # A recuperacao e verificada ANTES de aplicar qualquer migracao.
  Push-Location -LiteralPath $previous.root
  try{Run-Node -Arguments @('--experimental-strip-types','scripts/backup-postgres.mjs','create','--offline');$candidate=Get-ChildItem -LiteralPath (Join-Path $previous.dataRoot 'backups') -Directory | Sort-Object Name -Descending | Select-Object -First 1;Copy-Item -LiteralPath $candidate.FullName -Destination $ExternalBackupPath -Recurse;Run-Node -Arguments @('--experimental-strip-types','scripts/backup-postgres.mjs','verify','--backup',(Join-Path $ExternalBackupPath $candidate.Name))}finally{Pop-Location}
 }else{
  if($LegacySqlite){
   $legacyBackup=Join-Path $ExternalBackupPath ('pre-migracao-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
   Run-Node -Arguments @('--experimental-strip-types','server/backup-legacy.mjs',$legacyRoot,$legacyBackup,(Join-Path $DataRoot 'recovery.key'))
   $keyExport=Join-Path $RecoveryKeyDirectory "$env:COMPUTERNAME-recovery.key"
   if(Test-Path -LiteralPath $keyExport){if((Get-FileHash -LiteralPath $keyExport).Hash -ne (Get-FileHash -LiteralPath (Join-Path $DataRoot 'recovery.key')).Hash){throw 'Chave externa divergente.'}}else{Copy-Item -LiteralPath (Join-Path $DataRoot 'recovery.key') -Destination $keyExport}
  }
  Run-Node -Arguments @('--experimental-strip-types','scripts/postgres-local.mjs','init','--bin',$PostgresBin,'--data-root',$DataRoot,'--port',"$PostgresPort",'--database','next_portaria')
 }
 $env:PORTO_DB_PROVIDER='postgres'
 Run-Node -Arguments @('--experimental-strip-types','scripts/postgres-local.mjs','migrate')
 if($LegacySqlite -and !$previous){Run-Node -Arguments @('--experimental-strip-types','scripts/migrate-sqlite-to-postgres.mjs','--offline','--sqlite',$LegacySqlite,'--state-root',$LegacyStateRoot)}
 & $npm run check;if($LASTEXITCODE -ne 0){throw 'Verificacao de tipos falhou.'}
 & $npm test;if($LASTEXITCODE -ne 0){throw 'Testes falharam.'}
 & $npm run build;if($LASTEXITCODE -ne 0){throw 'Compilacao falhou.'}
 Run-Node -Arguments @('--experimental-strip-types','scripts/create-local-admin.mjs')
 foreach($dir in @('tls','run','logs')){New-Item -ItemType Directory -Path (Join-Path $DataRoot $dir) -Force | Out-Null}
 Copy-Item -LiteralPath $CertificatePath -Destination (Join-Path $DataRoot 'tls\certificate.pem')
 Copy-Item -LiteralPath $PrivateKeyPath -Destination (Join-Path $DataRoot 'tls\private.key')
 $server=@{host=$HostIP;port=$Port;uiPort=$UiPort;subnet=$Subnet;cert=(Join-Path $DataRoot 'tls\certificate.pem');key=(Join-Path $DataRoot 'tls\private.key')}
 Save-Json $server (Join-Path $release '.porto-runtime\server.json')
 Run-Node -Arguments @('--experimental-strip-types','server/validate-config.mjs')
 $config=Get-Content -LiteralPath '.porto-runtime\postgres.json' -Raw | ConvertFrom-Json
 if(!$previous){
  Run-Node -Arguments @('--experimental-strip-types','scripts/postgres-local.mjs','stop')
  Set-PrivateAcl $DataRoot @('*S-1-5-19:RX','*S-1-5-20:RX')
  Set-PrivateAcl $config.cluster @('*S-1-5-20:(OI)(CI)F')
  New-Item -ItemType Directory -Path (Join-Path $DataRoot 'pglogs') -Force | Out-Null
  Set-PrivateAcl (Join-Path $DataRoot 'pglogs') @('*S-1-5-20:(OI)(CI)M')
  $pgLogPath=(Join-Path $DataRoot 'pglogs').Replace('\','/').Replace("'","''")
  Add-Content -LiteralPath (Join-Path $config.cluster 'postgresql.auto.conf') -Value "`nlogging_collector = on`nlog_directory = '$pgLogPath'`nlog_filename = 'postgresql-%Y-%m-%d.log'" -Encoding ASCII
  if(Get-Service -Name 'NextPortaria-Postgres' -ErrorAction SilentlyContinue){throw 'Servico PostgreSQL homonimo nao reconhecido.'}
  & (Join-Path $PostgresBin 'pg_ctl.exe') register -N 'NextPortaria-Postgres' -D $config.cluster -U 'NT AUTHORITY\NetworkService' -S auto
  if($LASTEXITCODE -ne 0){throw 'Registro do servico PostgreSQL falhou.'}
  Start-Service -Name 'NextPortaria-Postgres'
 }
 $config|Add-Member -NotePropertyName manageCluster -NotePropertyValue $false -Force;Save-Json $config (Join-Path $release '.porto-runtime\postgres.json')
 Set-PrivateAcl $release @('*S-1-5-19:(OI)(CI)RX')
 Set-PrivateAcl (Join-Path $release '.porto-runtime') @('*S-1-5-19:(OI)(CI)RX')
 # Node precisa ser legivel pela conta LocalService, sem receber permissao de escrita.
 & icacls.exe (Split-Path $NodePath) /grant '*S-1-5-19:(OI)(CI)RX' | Out-Null
 & icacls.exe (Split-Path $PostgresBin) /grant '*S-1-5-20:(OI)(CI)RX' | Out-Null
 foreach($dir in @('media','run','logs','tls')){Set-PrivateAcl (Join-Path $DataRoot $dir) @($(if($dir -eq 'tls'){'*S-1-5-19:(OI)(CI)RX'}else{'*S-1-5-19:(OI)(CI)M'}))}
 foreach($dir in @('.vinext')){New-Item -ItemType Directory -Path (Join-Path $release $dir) -Force | Out-Null;Set-PrivateAcl (Join-Path $release $dir) @('*S-1-5-19:(OI)(CI)M')}
 Save-Json @{root=$release;dataRoot=$DataRoot;node=$NodePath;uiPort=$UiPort;version=$manifest.version;commit=$manifest.commit;previousRoot=$previous.root} $currentPath
 Save-Json @{externalPath=$ExternalBackupPath;keyDirectory=$RecoveryKeyDirectory} (Join-Path $InstallRoot 'backup.json')
 Set-PrivateAcl $InstallRoot @('*S-1-5-19:RX')
 & icacls.exe $currentPath /grant '*S-1-5-19:R' | Out-Null
 $runner=Join-Path $release 'server\RUN-SERVER.ps1'
 $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -InstallRoot `"$InstallRoot`""
 $principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited
 $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
 Register-ScheduledTask -TaskName 'NextPortaria-App' -Action $action -Principal $principal -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Force | Out-Null
 $backupAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $release 'server\BACKUP-SERVER.ps1')`" -InstallRoot `"$InstallRoot`""
 Register-ScheduledTask -TaskName 'NextPortaria-Backup' -Action $backupAction -Principal (New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest) -Trigger (New-ScheduledTaskTrigger -Daily -At '02:00') -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 4) -MultipleInstances IgnoreNew) -Force | Out-Null
 $retentionAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $release 'server\RETENCAO-SERVER.ps1')`" -InstallRoot `"$InstallRoot`""
 Register-ScheduledTask -TaskName 'NextPortaria-Retencao' -Action $retentionAction -Principal (New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest) -Trigger (New-ScheduledTaskTrigger -Daily -At '01:00') -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew) -Force | Out-Null
 if(!(Get-NetFirewallRule -Name 'NextPortaria-HTTPS' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name 'NextPortaria-HTTPS' -DisplayName 'Next Portaria HTTPS interno' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $HostIP -LocalPort $Port -RemoteAddress $Subnet -Profile Domain,Private | Out-Null}else{Set-NetFirewallRule -Name 'NextPortaria-HTTPS' -Enabled True -Direction Inbound -Action Allow -Profile Domain,Private;Get-NetFirewallRule -Name 'NextPortaria-HTTPS'|Get-NetFirewallAddressFilter|Set-NetFirewallAddressFilter -LocalAddress $HostIP -RemoteAddress $Subnet;Get-NetFirewallRule -Name 'NextPortaria-HTTPS'|Get-NetFirewallPortFilter|Set-NetFirewallPortFilter -LocalPort $Port -Protocol TCP}
 # Executa como SYSTEM para validar a permissao REAL de acesso ao compartilhamento.
 $maintenance.ReleaseMutex();$ownsMaintenance=$false
 $requestedAt=Get-Date
 Start-ScheduledTask -TaskName 'NextPortaria-Backup'
 $deadline=(Get-Date).AddMinutes(15)
 do{Start-Sleep -Seconds 2;$task=Get-ScheduledTask -TaskName 'NextPortaria-Backup';$info=Get-ScheduledTaskInfo -TaskName 'NextPortaria-Backup';if((Get-Date) -gt $deadline){throw 'Backup externo excedeu o prazo; confira o agendador.'}}while($task.State -eq 'Running' -or $info.LastRunTime -lt $requestedAt.AddSeconds(-2))
 if((Get-ScheduledTaskInfo -TaskName 'NextPortaria-Backup').LastTaskResult -ne 0 -or !(Test-Path -LiteralPath (Join-Path $InstallRoot 'last-backup.json'))){throw 'Backup externo por SYSTEM nao foi confirmado. Libere a conta do computador no compartilhamento antes de ativar.'}
 Start-ScheduledTask -TaskName 'NextPortaria-App'
 try{Run-Node -Arguments @('server/health.mjs')}catch{Stop-ScheduledTask -TaskName 'NextPortaria-App';throw}
 Write-Host "Release preparada em $release. Acesso esperado: https://${HostIP}:$Port"
 Write-Host 'Valide o certificado nos clientes, login, reinicio sem login e acesso externo antes de considerar a implantacao concluida.'
} finally {if($ownsMaintenance){$maintenance.ReleaseMutex()};$maintenance.Dispose();Pop-Location}

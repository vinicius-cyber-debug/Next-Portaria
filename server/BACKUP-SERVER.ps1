param([Parameter(Mandatory)][string]$InstallRoot)
$ErrorActionPreference='Stop'
$active=Get-Content -LiteralPath (Join-Path $InstallRoot 'current.json') -Raw | ConvertFrom-Json
$job=Get-Content -LiteralPath (Join-Path $InstallRoot 'backup.json') -Raw | ConvertFrom-Json
if(!$job.externalPath.StartsWith('\\') -or !(Test-Path -LiteralPath $job.externalPath)){throw 'Destino externo indisponivel.'}
$stamp=Get-Date -Format 'yyyy-MM-ddTHH-mm-ss-fff'
$local=Join-Path $active.dataRoot "backups\$stamp"
$remote=Join-Path $job.externalPath "$env:COMPUTERNAME-$stamp"
$env:PORTO_PORT=[string]$active.uiPort
$mutex=New-Object Threading.Mutex($false,'Global\NextPortariaMaintenance')
if(!$mutex.WaitOne(0)){throw 'Outra manutencao Next Portaria esta em execucao.'}
$wasRunning=(Get-ScheduledTask -TaskName 'NextPortaria-App').State -eq 'Running'
try {
 Stop-ScheduledTask -TaskName 'NextPortaria-App'
 $deadline=(Get-Date).AddSeconds(30)
 while(Get-NetTCPConnection -State Listen -LocalPort $active.uiPort -ErrorAction SilentlyContinue){if((Get-Date) -gt $deadline){throw 'Aplicacao nao encerrou para o backup.'}; Start-Sleep -Milliseconds 500}
 Push-Location -LiteralPath $active.root
 try {
  & $active.node '--experimental-strip-types' 'scripts/backup-postgres.mjs' create --offline --destination $local
  if($LASTEXITCODE -ne 0){throw 'Backup ou recuperacao local falhou.'}
  New-Item -ItemType Directory -Path $remote -ErrorAction Stop | Out-Null
  Get-ChildItem -LiteralPath $local -File | Copy-Item -Destination $remote -ErrorAction Stop
  foreach($file in Get-ChildItem -LiteralPath $local -File){if((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath (Join-Path $remote $file.Name)).Hash){throw 'Copia externa divergente.'}}
  & $active.node '--experimental-strip-types' 'scripts/backup-postgres.mjs' verify --backup $remote
  if($LASTEXITCODE -ne 0){throw 'Recuperacao da copia externa falhou.'}
  $key=Join-Path $active.dataRoot 'recovery.key'
  $export=Join-Path $job.keyDirectory "$env:COMPUTERNAME-recovery.key"
  if(Test-Path -LiteralPath $export){if((Get-FileHash -LiteralPath $key).Hash -ne (Get-FileHash -LiteralPath $export).Hash){throw 'A chave externa existente e diferente.'}}else{Copy-Item -LiteralPath $key -Destination $export -ErrorAction Stop}
  @{status='verified';external=$remote;verifiedAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot 'last-backup.json') -Encoding UTF8
 } finally {Pop-Location}
} finally {if($wasRunning){Start-ScheduledTask -TaskName 'NextPortaria-App'};$mutex.ReleaseMutex();$mutex.Dispose()}

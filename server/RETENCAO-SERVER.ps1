param([Parameter(Mandatory)][string]$InstallRoot)
$ErrorActionPreference='Stop'
$active=Get-Content -LiteralPath (Join-Path $InstallRoot 'current.json') -Raw | ConvertFrom-Json
$mutex=New-Object Threading.Mutex($false,'Global\NextPortariaMaintenance')
if(!$mutex.WaitOne(0)){throw 'Backup ou manutencao em andamento; retencao adiada.'}
Push-Location -LiteralPath $active.root
try{& $active.node '--experimental-strip-types' 'scripts/media-retention.mjs' *>> (Join-Path $active.dataRoot 'logs\retention.log');exit $LASTEXITCODE}finally{Pop-Location;$mutex.ReleaseMutex();$mutex.Dispose()}

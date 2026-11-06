param([Parameter(Mandatory)][string]$InstallRoot)
$ErrorActionPreference='Stop'
try {
 $active=Get-Content -LiteralPath (Join-Path $InstallRoot 'current.json') -Raw | ConvertFrom-Json
 Set-Location -LiteralPath $active.root
 $env:PORTO_NATIVE_PROCESS_FILE=Join-Path $active.dataRoot 'run\native-process.json'
 $env:PORTO_SERVER_CONFIG=Join-Path $active.root '.porto-runtime\server.json'
 & $active.node '--experimental-strip-types' 'scripts/server-process.mjs' *>> (Join-Path $active.dataRoot 'logs\application.log')
 exit $LASTEXITCODE
} catch {Write-Error $_;exit 1}

param([string]$InstallRoot='C:\NextPortaria-Instalacao',[string]$DataRoot='C:\NextPortaria-Dados')
$ErrorActionPreference='Stop'
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture
Get-Command node.exe,npm.cmd,git.exe -ErrorAction SilentlyContinue | Select-Object Name,Source
if(Get-Command node.exe -ErrorAction SilentlyContinue){ & node.exe --version }
Get-NetTCPConnection -State Listen | Where-Object LocalPort -In 443,8443,5180,55432 | Select-Object LocalAddress,LocalPort,OwningProcess
Get-Service | Where-Object Name -Match 'postgres|portaria' | Select-Object Name,Status,StartType
Get-ScheduledTask | Where-Object TaskName -Match 'Portaria' | Select-Object TaskName,State
foreach($path in @($InstallRoot,$DataRoot)){
 if(Test-Path -LiteralPath $path){Get-Item -LiteralPath $path | Select-Object FullName,LastWriteTime; Get-ChildItem -LiteralPath $path -Force | Select-Object Name,Mode,LastWriteTime}
}
foreach($state in @((Join-Path $InstallRoot 'app\.wrangler\state'),(Join-Path $InstallRoot '.wrangler\state'))){if(Test-Path -LiteralPath $state){Get-ChildItem -LiteralPath $state -Filter '*.sqlite' -Recurse -File | Select-Object FullName,Length,LastWriteTime}}
Write-Host 'Inspecao somente leitura. Nenhuma instalacao, banco ou regra foi alterada.'

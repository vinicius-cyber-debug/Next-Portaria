param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$projectPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# GetFolderPath's default Verify mode returns an empty string when Startup has
# never been created in a fresh profile. Resolve only this user's known folder.
$profilePath = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($profilePath)) {
  $profilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile, [Environment+SpecialFolderOption]::DoNotVerify)
}
if ([string]::IsNullOrWhiteSpace($profilePath) -or -not [IO.Path]::IsPathRooted($profilePath)) {
  throw 'Nao foi possivel identificar o perfil Windows atual para instalar a inicializacao.'
}
$profilePath = [IO.Path]::GetFullPath($profilePath).TrimEnd([IO.Path]::DirectorySeparatorChar)
$profilePrefix = $profilePath + [IO.Path]::DirectorySeparatorChar
$registryStartup = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -Name Startup -ErrorAction SilentlyContinue).Startup
$startupCandidates = @(
  [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup, [Environment+SpecialFolderOption]::DoNotVerify)
  $registryStartup
)
foreach ($appDataPath in @($env:APPDATA, [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData, [Environment+SpecialFolderOption]::DoNotVerify), (Join-Path $profilePath 'AppData\Roaming'))) {
  if (-not [string]::IsNullOrWhiteSpace($appDataPath)) {
    $startupCandidates += Join-Path $appDataPath 'Microsoft\Windows\Start Menu\Programs\Startup'
  }
}
$startupPath = $null
foreach ($candidate in $startupCandidates) {
  if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
  $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
  if (-not [IO.Path]::IsPathRooted($expanded)) { continue }
  try { $resolved = [IO.Path]::GetFullPath($expanded) } catch { continue }
  if ($resolved.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $startupPath = $resolved
    break
  }
}
if ([string]::IsNullOrWhiteSpace($startupPath)) {
  throw 'Nao foi encontrada uma pasta Inicializar absoluta dentro do perfil Windows atual.'
}
$identityHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($projectPath))).Replace('-', '').Substring(0, 12)
$shortcutPath = Join-Path $startupPath ("Porto Gestao $identityHash.lnk")
if ($Remove) {
  if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
  Write-Output 'Inicializacao automatica removida para esta conta Windows. O servidor atual continua ativo.'
  exit 0
}
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $projectPath 'dist/server/wrangler.json'))) { throw 'Execute ATUALIZAR-PORTO-LOCAL.cmd antes de instalar a inicializacao automatica.' }
$runtimePath = Join-Path $projectPath '.porto-runtime'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$launcherPath = Join-Path $runtimePath 'launch.vbs'
$launchCommand = '"' + $nodePath + '" "' + (Join-Path $projectPath 'scripts/local-service.mjs') + '" start'
$launchSource = 'CreateObject("WScript.Shell").Run "' + $launchCommand.Replace('"', '""') + '", 0, False'
[IO.File]::WriteAllText($launcherPath, $launchSource, [Text.Encoding]::Unicode)
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/wscript.exe'
$shortcut.Arguments = '"' + $launcherPath + '"'
$shortcut.WorkingDirectory = $projectPath
$shortcut.Description = 'Next Portaria local - iniciar ao entrar nesta conta Windows'
$shortcut.WindowStyle = 7
New-Item -ItemType Directory -Path $startupPath -Force | Out-Null
$shortcut.Save()
Write-Output "Inicializacao automatica instalada para esta conta: $shortcutPath"
Write-Output 'O servidor inicia apos entrar no Windows. Nao e um servico antes do login.'

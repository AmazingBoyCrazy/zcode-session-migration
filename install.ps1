# Install this skill into the local DSH skills directory.
#
#   pwsh -File install.ps1              # install / update
#   pwsh -File install.ps1 -Uninstall   # remove
#
# Honors $DSH_HOME, falling back to ~/.dsh.
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$DshHome
)

$ErrorActionPreference = 'Stop'
$skillName = 'zcode-session-migration'
$source = $PSScriptRoot
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
$target = Join-Path (Join-Path $DshHome 'skills') $skillName

if ($Uninstall) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force; Write-Host "removed $target" }
    else { Write-Host "not installed: $target" }
    return
}

if (-not (Test-Path (Join-Path $source 'SKILL.md'))) {
    throw "SKILL.md not found next to install.ps1; run this from the repository root."
}

New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $source 'SKILL.md') $target -Force
foreach ($dir in 'references', 'scripts') {
    $from = Join-Path $source $dir
    if (Test-Path $from) { Copy-Item $from $target -Recurse -Force }
}

Write-Host "installed $skillName -> $target"
Write-Host 'Start a new DSH session for the skill to appear in the catalog.'

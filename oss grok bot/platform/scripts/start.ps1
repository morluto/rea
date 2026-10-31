$ErrorActionPreference = 'Stop'
$platformRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $platformRoot
$runtime = Join-Path $platformRoot 'node_modules/node/bin/node.exe'
if (-not (Test-Path -LiteralPath $runtime)) { throw 'Run npm ci in the platform directory first. No host runtime will be installed or changed by this script.' }
$dataRoot = if ($env:WORKSHOP_DATA) { [System.IO.Path]::GetFullPath($env:WORKSHOP_DATA) } else { Join-Path $platformRoot '.local' }
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# New product data is private to this Windows account. Existing explicit grants
# are inspectable with icacls; this command removes inherited grants only.
& icacls $dataRoot /inheritance:r /grant:r "*${currentSid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the local data directory.' }
& $runtime --experimental-sqlite packages/host/src/server.mjs
exit $LASTEXITCODE

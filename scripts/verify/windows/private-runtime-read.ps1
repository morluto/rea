param([Parameter(Mandatory)][string] $Root, [Parameter(Mandatory)][string] $Probe)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Root -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($Root) -cne $Root -or
    [IO.Path]::GetFileName($Root) -notmatch '^private-[0-9a-f]{32}$') {
    throw 'Expected the absolute local runtime path printed by the owner.'
}

function Read-Fixture([string] $Path) {
    $result = & $Probe read-fixture-data ([IO.Path]::GetFullPath($Path))
    if ($LASTEXITCODE -ne 0 -or $result -notin '0','5') { throw "Fixture probe failed: $Path" }
    return [int]$result
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$control = Read-Fixture ([IO.Path]::Combine([IO.Path]::GetDirectoryName($Root), 'control.bin'))
$files = [ordered]@{}
foreach ($name in 'descriptor.json','session.token','snapshot.bin','session.log','project/data.bin') {
    $files[$name] = Read-Fixture ([IO.Path]::Combine($Root, $name))
}
[ordered]@{
    root = $Root; sid = $identity.User.Value
    localUser = [Environment]::UserDomainName -eq [Environment]::MachineName
    administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    control = $control; files = $files
} | ConvertTo-Json -Compress

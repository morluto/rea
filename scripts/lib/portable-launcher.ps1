# Use PowerShell's native boundary for CLI cwd, pipelines and interactive TTY.
$ErrorActionPreference = 'Stop'
$reaNode = Join-Path $PSScriptRoot 'runtime/node.exe'
$reaArguments = @((Join-Path $PSScriptRoot 'runtime/launch.mjs')) + $args
$reaQuotedArguments = @($reaArguments | ForEach-Object {
  '"' + (([string]$_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
})
# The dispatcher's two stdio modes need inherited handles: Windows PowerShell
# buffers native-command input, which deadlocks a full-duplex MCP connection.
# Do not bind script pipeline input: it would consume the protocol's stdin.
if ($args.Count -eq 1 -and $args[0] -cin @('mcp', '--mcp')) {
  $reaStart = [System.Diagnostics.ProcessStartInfo]::new()
  $reaStart.FileName = $reaNode
  $reaStart.UseShellExecute = $false
  $reaStart.WorkingDirectory = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.Path
  $reaStart.Arguments = $reaQuotedArguments -join ' '
  $reaProcess = [System.Diagnostics.Process]::Start($reaStart)
  try {
    $reaProcess.WaitForExit()
    $reaExitCode = $reaProcess.ExitCode
  } finally {
    $reaProcess.Dispose()
  }
  exit $reaExitCode
}
$reaPassing = $ExecutionContext.SessionState.PSVariable.Get('PSNativeCommandArgumentPassing')
if ($null -eq $reaPassing -or $reaPassing.Value -eq 'Legacy') {
  # Legacy binding accepts prequoted CRT tokens. Standard binding takes raw args.
  $reaArguments = $reaQuotedArguments
}
$reaOriginalEncoding = [Console]::OutputEncoding
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$reaExitCode = 1
try {
  [Console]::OutputEncoding = $OutputEncoding
  # Native stderr is diagnostic output; the child's exit status decides failure.
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 1
  & $reaNode @reaArguments
  $reaExitCode = $LASTEXITCODE
} finally {
  [Console]::OutputEncoding = $reaOriginalEncoding
}
exit $reaExitCode

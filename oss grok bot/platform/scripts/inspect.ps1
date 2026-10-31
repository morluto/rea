$ErrorActionPreference = 'Stop'
Invoke-RestMethod 'http://127.0.0.1:4317/api/health' | Format-List
if (Get-Command docker -ErrorAction SilentlyContinue) {
  docker info --format '{{json .ServerVersion}}'
  docker ps -a --filter 'name=bot-workshop-' --format '{{.ID}} {{.Names}} {{.Status}} {{.Labels}}'
  docker volume ls --filter 'name=bot-workshop-'
} else { Write-Output 'Docker CLI unavailable; Linux engine connectivity is unverified.' }

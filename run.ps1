# Start Absolute Cinema on Windows and print the address to open.
#
#   .\run.ps1           start (downloads the app the first time)
#   .\run.ps1 stop      stop it
#   .\run.ps1 logs      follow its logs
#   .\run.ps1 update    get the newest version and restart
param([string]$Action = "start")
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$port = $env:AC_PORT
if (-not $port -and (Test-Path ".env")) {
  $line = Get-Content ".env" | Where-Object { $_ -match '^AC_PORT=' } | Select-Object -First 1
  if ($line) { $port = $line.Split("=", 2)[1].Trim() }
}
if (-not $port) { $port = "3000" }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker is not installed. Get Docker Desktop from https://www.docker.com/products/docker-desktop/ and run this again."
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker is installed but not running. Open Docker Desktop, wait until it says it is running, then run this again."
  exit 1
}

switch ($Action) {
  "stop"   { docker compose down; exit 0 }
  "logs"   { docker compose logs -f --tail=100; exit 0 }
  "update" { docker compose pull; docker compose up -d }
  "start"  { docker compose up -d }
  default  { Write-Host "usage: .\run.ps1 [start|stop|logs|update]"; exit 1 }
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Starting Absolute Cinema (the first start downloads the app, about 4 GB unpacked, and takes a few minutes)..."
for ($i = 0; $i -lt 180; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$port/api/health" | Out-Null
    $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
      Select-Object -First 1).IPAddress
    Write-Host ""
    Write-Host "  Absolute Cinema is running."
    Write-Host "  On this computer:        http://localhost:$port"
    if ($lan) { Write-Host "  On your phone or TV:     http://${lan}:$port  (same Wi-Fi)" }
    Write-Host ""
    Write-Host "  Stop it with .\run.ps1 stop"
    Start-Process "http://localhost:$port"
    exit 0
  } catch {
    Start-Sleep -Seconds 2
  }
}
Write-Host "It did not start within 6 minutes. See what happened with: .\run.ps1 logs"
exit 1

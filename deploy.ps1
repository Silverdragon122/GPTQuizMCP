$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue

if (-not $node -or -not $npm) {
  Write-Host "Node.js and npm are required. I can try to install Node.js LTS with winget."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Write-Host "If this is a fresh install, close this terminal, open a new one, and run .\deploy.ps1 again."
  } else {
    Write-Host "winget is not available. Install Node.js LTS from https://nodejs.org, then run .\deploy.ps1 again."
  }
  exit 1
}

node scripts/deploy.mjs

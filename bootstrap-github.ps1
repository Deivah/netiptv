
param(
  [Parameter(Mandatory=$true)][string]$GithubUser,
  [Parameter(Mandatory=$true)][string]$RepoName,
  [switch]$CreateTag
)

Write-Host "==> NetIPTV GitHub bootstrap" -ForegroundColor Cyan
# Ensure Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "Git saknas. Försöker installera via winget..." -ForegroundColor Yellow
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget saknas. Installera Git manuellt: https://git-scm.com/download/win" -ForegroundColor Red
    exit 1
  }
  winget install --id Git.Git -e --silent
}

# Ensure Node (optional for local run)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js saknas. Försöker installera via winget..." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --silent
  }
}

# Ask for a GitHub Personal Access Token (fine scope: repo)
$Token = Read-Host -AsSecureString "Klistra in en GitHub Personal Access Token (repo-rättigheter)"
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
$PlainToken = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($BSTR)

$repoApi = "https://api.github.com/user/repos"

Write-Host "Skapar repo $RepoName på GitHub (om det inte redan finns)..." -ForegroundColor Cyan
try {
  $body = @{ name = $RepoName; private = $false } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri $repoApi -Headers @{ Authorization = "token $PlainToken"; "User-Agent"="netiptv-bootstrap" } -Body $body -ContentType "application/json"
  Write-Host "Repo skapat: $($resp.html_url)" -ForegroundColor Green
} catch {
  Write-Host "Repo finns redan eller kunde inte skapas. Försöker fortsätta ändå..." -ForegroundColor Yellow
}

# Git init & push
git init
git add .
git commit -m "Init NetIPTV"
git branch -M main
git remote remove origin 2>$null
git remote add origin https://github.com/$GithubUser/$RepoName.git
git push -u origin main

# Ensure workflow file exists
if (-not (Test-Path ".github/workflows/build.yml")) {
  New-Item -ItemType Directory -Path ".github/workflows" -Force | Out-Null
  $yml = @"
name: Build NetIPTV Windows

on:
  workflow_dispatch:
  push:
    tags:
      - 'v*.*.*'

jobs:
  build:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install deps
        run: |
          npm ci || npm install

      - name: Build Windows installer
        run: npm run dist

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: NetIPTV-Windows-Installer
          path: |
            dist/*.exe
            dist/*.msi
            dist/*.zip
          if-no-files-found: warn
"@
  $yml | Set-Content ".github/workflows/build.yml" -Encoding UTF8
  git add .github/workflows/build.yml
  git commit -m "Add GitHub Actions workflow"
  git push
}

if ($CreateTag) {
  $tag = "v1.0.0"
  git tag $tag
  git push origin $tag
  Write-Host "Tagg $tag pushad. Actions skapar en Release med .exe." -ForegroundColor Green
} else {
  Write-Host "Gå till fliken Actions i ditt repo och kör workflow: 'Build NetIPTV Windows'." -ForegroundColor Green
}

Write-Host "Klart!" -ForegroundColor Green

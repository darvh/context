# Context installer — Windows PowerShell.
#
#   irm https://raw.githubusercontent.com/darvh/context/main/install.ps1 | iex
#   powershell -File install.ps1 [-Local] [-Targets a,b] [-Version v0.1.0]
#                                [-Force] [-DryRun] [-Hooks]

$ErrorActionPreference = "Stop"

$mode = "global"
$targets = "all"
$version = ""
$force = $false
$dryRun = $false
$hooks = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  switch (($args[$i] -replace "^[-]+", "").ToLower()) {
    "local" { $mode = "local" }
    "targets" { $targets = $args[++$i] }
    "version" { $version = $args[++$i] }
    "force" { $force = $true }
    "dry-run" { $dryRun = $true }
    "hooks" { $hooks = $true }
    default { throw "context: unknown option: $($args[$i])" }
  }
}

$installRoot = Join-Path $HOME ".local\share\context"
$binDir = Join-Path $HOME ".local\bin"
$source = $PSScriptRoot
$temp = $null

function Acquire-Source {
  if ($source -and (Test-Path (Join-Path $source "package.json")) -and (Test-Path (Join-Path $source "skill\SKILL.md"))) { return }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "context: source fallback requires git" }
  if (-not $script:temp) {
    $script:temp = Join-Path ([System.IO.Path]::GetTempPath()) ("context-install-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $script:temp | Out-Null
  }
  $clone = Join-Path $script:temp "source"
  & git clone --depth 1 https://github.com/darvh/context.git $clone | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "context: source clone failed" }
  $script:source = $clone
}

function Write-Launcher {
  param([string]$Root)
  $binary = Join-Path $Root "dist\context.exe"
  $launcher = @"
`$ErrorActionPreference = "Continue"
`$binary = "$binary"
if (Test-Path `$binary) {
  try {
    & `$binary `$args
    exit `$LASTEXITCODE
  } catch {
    Write-Warning "context: compiled binary could not run; falling back to source"
  }
}
if (Test-Path "$Root\src\cli.ts") {
  & bun run "$Root\src\cli.ts" `$args
  exit `$LASTEXITCODE
}
Write-Error "context: cannot execute compiled binary and Bun source fallback is unavailable"
exit 1
"@
  Set-Content (Join-Path $binDir "context.ps1") $launcher
  $cmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$binDir\context.ps1`" %*"
  Set-Content (Join-Path $binDir "context.cmd") $cmd
}

function Install-Source {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "context: Bun is required for source installation (https://bun.sh/)" }
  Acquire-Source
  if ($mode -eq "global") {
    if (Test-Path $installRoot) { Remove-Item -Recurse -Force $installRoot }
    New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
    Copy-Item -Recurse -Force (Join-Path $source "*") $installRoot
    Push-Location $installRoot
    bun install --frozen-lockfile
    bun run build | Out-Null
    Pop-Location
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Write-Launcher $installRoot
  }
  $runtime = if ($mode -eq "local") { $source } else { $installRoot }
  $init = @("run", (Join-Path $runtime "src\cli.ts"), "init", "--targets", $targets)
  if ($mode -eq "local") { $init += @("--project", "--root", (Get-Location).Path) }
  if ($force) { $init += "--force" }
  if ($dryRun) { $init += "--dry-run" }
  if ($hooks) { $init += "--hooks" }
  & bun $init
}

function Install-Release {
  if ($hooks) { return $false }
  if (-not ($env:PROCESSOR_ARCHITECTURE -in @("AMD64", "x86_64"))) { return $false }
  try {
    $tag = $version
    if (-not $tag) { $tag = (Invoke-RestMethod https://api.github.com/repos/darvh/context/releases/latest).tag_name }
    if ($tag -notmatch '^v\d+\.\d+\.\d+$') { return $false }
    $asset = "context-$tag-windows-x64.zip"
    if (-not $script:temp) {
      $script:temp = Join-Path ([System.IO.Path]::GetTempPath()) ("context-install-" + [guid]::NewGuid())
      New-Item -ItemType Directory -Force -Path $script:temp | Out-Null
    }
    $archive = Join-Path $script:temp $asset
    Invoke-WebRequest "https://github.com/darvh/context/releases/download/$tag/$asset" -OutFile $archive
    $extract = Join-Path $script:temp "extract"
    Expand-Archive -Path $archive -DestinationPath $extract
    $runtime = Join-Path $extract "context"
    if (-not (Test-Path (Join-Path $runtime "dist\context.exe"))) { return $false }
    if (Test-Path $installRoot) { Remove-Item -Recurse -Force $installRoot }
    New-Item -ItemType Directory -Force -Path (Split-Path $installRoot) | Out-Null
    Move-Item $runtime $installRoot
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Write-Launcher $installRoot
    $init = @("init", "--targets", $targets)
    if ($force) { $init += "--force" }
    & (Join-Path $installRoot "dist\context.exe") $init
    return $true
  } catch {
    return $false
  }
}

try {
  if ($dryRun) {
    Write-Host "context install (scope: $mode, targets: $targets, platform: windows-x64)"
    if ($mode -eq "global") {
      $displayVersion = if ($version) { $version } else { "latest" }
      Write-Host "  release asset: context-$displayVersion-windows-x64.zip"
    }
    if ($hooks) { Write-Host "  hooks: source fallback required" }
  } elseif ($mode -eq "local" -or $hooks) {
    Install-Source
  } elseif (-not (Install-Release)) {
    Write-Warning "context: release unavailable; falling back to source installation"
    Install-Source
  }
} finally {
  if ($temp -and (Test-Path $temp)) { Remove-Item -Recurse -Force $temp }
}

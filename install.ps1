# Context installer — Windows PowerShell.
#
#   irm https://raw.githubusercontent.com/darvh/context/main/install.ps1 | iex
#   powershell -File install.ps1 [-Local] [-Targets a,b] [-Force] [-DryRun] [-Hooks]

$ErrorActionPreference = "Stop"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw "context: Bun is required (https://bun.sh/)"
}

$source = $PSScriptRoot
if (-not $source -or -not (Test-Path (Join-Path $source "package.json"))) {
  $temp = Join-Path $env:TEMP ("context-install-" + [guid]::NewGuid())
  & git clone --depth 1 https://github.com/darvh/context.git $temp | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "context: clone failed" }
  $source = $temp
}

$local = $false; $targets = "all"; $force = $false; $dryRun = $false; $hooks = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  switch (($args[$i] -replace "^[-]+", "").ToLower()) {
    "local" { $local = $true }
    "targets" { $targets = $args[++$i] }
    "force" { $force = $true }
    "dry-run" { $dryRun = $true }
    "hooks" { $hooks = $true }
    default { throw "context: unknown option: $($args[$i])" }
  }
}

$installRoot = Join-Path $HOME ".local\share\context"
$binDir = Join-Path $HOME ".local\bin"
if (-not $local -and -not $dryRun) {
  if (Test-Path $installRoot) { Remove-Item -Recurse -Force $installRoot }
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Copy-Item -Recurse -Force (Join-Path $source ".\*") $installRoot
  Push-Location $installRoot; bun install --frozen-lockfile; Pop-Location
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $wrapper = Join-Path $binDir "context.ps1"
  Push-Location $installRoot; bun run build | Out-Null; Pop-Location
  Set-Content $wrapper "& `"$installRoot\dist\context`" `$args"
}

$runtime = if ($local) { $source } else { $installRoot }
if ($dryRun -and -not $local) {
  Write-Host "context install (global, dry-run; runtime would be $installRoot)"
} else {
  $init = @("run", (Join-Path $runtime "src\cli.ts"), "init")
  if ($local) { $init += @("--project", "--root", (Get-Location).Path) }
  $init += @("--targets", $targets)
  if ($force) { $init += "--force" }
  if ($dryRun) { $init += "--dry-run" }
  if ($hooks) { $init += "--hooks" }
  & bun $init
}

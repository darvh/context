# Context installer — Windows PowerShell.
#
#   irm https://raw.githubusercontent.com/darvh/context/main/install.ps1 | iex
#   powershell -File install.ps1 [-Local] [-Targets a,b] [-Version v0.1.0]
#                                [-Force|-NoForce] [-DryRun] [-Hooks|-NoHooks]
#                                [-FromSource] [-NoModifyPath] [-Uninstall]
#                                [-Help]
#
# Global installs are binary-first: download the release ZIP for windows-x64,
# verify its published SHA-256, unpack to ~/.local/share/context, and write a
# launcher into ~/.local/bin. Source installs (checkout, -FromSource, or a
# missing release) require Bun. Hooks are self-hosted by the compiled binary,
# so -Hooks no longer forces a source build.

$ErrorActionPreference = "Stop"

$mode = "global"
$targets = "all"
$version = ""
$force = $true # installer intent: bring installed copies up to date
$dryRun = $false
$hooks = $true # hooks install by default
$fromSource = $false
$modifyPath = $true
$uninstall = $false

function Show-Usage {
  @"
context install.ps1

Installs the `context` command and its agent skill on Windows.

USAGE:
    install.ps1 [OPTIONS]

OPTIONS:
    -Local                Install into the current project (requires Bun)
    -Targets <agents>     Comma-separated agents (default: all)
    -Version <tag>        Release tag to install, for example v0.1.0
    -Force / -NoForce     Overwrite an existing install (default: force)
    -DryRun               Print the plan, install nothing
    -Hooks / -NoHooks     Wire host hooks (default: hooks)
    -FromSource           Install from a source checkout (requires Bun)
    -NoModifyPath         Do not add the bin dir to your user PATH
    -Uninstall            Remove the install, launcher, and PATH entry
    -Help                 Show this help

ENVIRONMENT:
    CONTEXT_HOME            Install prefix (default: ~\.local\share\context)
    CONTEXT_BIN_DIR         Launcher dir (default: ~\.local\bin)
    CONTEXT_NO_MODIFY_PATH  Set to 1 to skip PATH setup
    CONTEXT_VERSION         Release tag, same as -Version
"@
}

for ($i = 0; $i -lt $args.Count; $i++) {
  $flag = ($args[$i] -replace "^[-]+", "").ToLower()
  if ($flag -like "targets=*") { $targets = $flag.Substring(8); continue }
  if ($flag -like "version=*") { $version = $flag.Substring(8); continue }
  switch ($flag) {
    "local" { $mode = "local" }
    "targets" { $targets = $args[++$i] }
    "version" { $version = $args[++$i] }
    "force" { $force = $true }
    "no-force" { $force = $false }
    "dry-run" { $dryRun = $true }
    "hooks" { $hooks = $true }
    "no-hooks" { $hooks = $false }
    "from-source" { $fromSource = $true }
    "no-modify-path" { $modifyPath = $false }
    "uninstall" { $uninstall = $true }
    "h" { Show-Usage; exit 0 }
    "help" { Show-Usage; exit 0 }
    default { throw "context: unknown option: $($args[$i])" }
  }
}
if ($env:CONTEXT_VERSION -and -not $version) { $version = $env:CONTEXT_VERSION }
if ($env:CONTEXT_NO_MODIFY_PATH -eq "1") { $modifyPath = $false }

$installRoot = if ($env:CONTEXT_HOME) { $env:CONTEXT_HOME } else { Join-Path $HOME ".local\share\context" }
$binDir = if ($env:CONTEXT_BIN_DIR) { $env:CONTEXT_BIN_DIR } else { Join-Path $HOME ".local\bin" }
$legacyRoot = Join-Path $HOME ".context"
$source = $PSScriptRoot
$temp = $null

function Acquire-Source {
  if ($source -and (Test-Path (Join-Path $source "package.json")) -and (Test-Path (Join-Path $source "src\cli.ts"))) { return }
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
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  Set-Content (Join-Path $binDir "context.ps1") $launcher
  $cmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$binDir\context.ps1`" %*"
  Set-Content (Join-Path $binDir "context.cmd") $cmd
}

function Add-ToPath {
  if (($env:PATH -split ";") -notcontains $binDir) { $env:PATH = "$binDir;$env:PATH" }
  if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $binDir }
  if (-not $modifyPath) { return }
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ";") -notcontains $binDir) {
    $new = if ($userPath -and $userPath.Trim()) { "$userPath;$binDir" } else { $binDir }
    [Environment]::SetEnvironmentVariable("Path", $new, "User")
  }
}

function Remove-FromPath {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath) {
    $kept = ($userPath -split ";" | Where-Object { $_ -and $_ -ne $binDir }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $kept, "User")
  }
}

function Get-ExpectedChecksum {
  param([string]$ChecksumFile)
  if (-not (Test-Path $ChecksumFile)) { return "" }
  $line = (Get-Content -Path $ChecksumFile -TotalCount 1)
  if ($line -match "([A-Fa-f0-9]{64})") { return $Matches[1].ToLower() }
  return ""
}

function Test-Checksum {
  param([string]$File, [string]$ChecksumFile)
  $expected = Get-ExpectedChecksum $ChecksumFile
  if (-not $expected) {
    Write-Host "context: no published checksum; skipping verification"
    return $true
  }
  $actual = (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    Write-Host "context: checksum mismatch for $(Split-Path $File -Leaf)" -ForegroundColor Red
    return $false
  }
  Write-Host "context: verified sha256 $(Split-Path $File -Leaf)"
  return $true
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
    Write-Launcher $installRoot
  }
  $runtime = if ($mode -eq "local") { $source } else { $installRoot }
  $init = @("run", (Join-Path $runtime "src\cli.ts"), "init", "--targets", $targets, "--create")
  if ($force) { $init += "--force" }
  if ($dryRun) { $init += "--dry-run" }
  if (-not $hooks) { $init += "--no-hooks" }
  & bun $init
}

function Install-Release {
  if ($fromSource) { return $false }
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
    $base = "https://github.com/darvh/context/releases/download/$tag"
    Invoke-WebRequest "$base/$asset" -OutFile $archive
    $checksum = "$archive.sha256"
    try {
      Invoke-WebRequest "$base/$asset.sha256" -OutFile $checksum
      if (-not (Test-Checksum $archive $checksum)) { throw "context: aborting: release checksum verification failed" }
    } catch {
      if ($_.Exception.Message -like "*checksum verification failed*") { throw }
      Write-Host "context: no checksum asset published for $tag; skipping verification"
    }
    $extract = Join-Path $script:temp "extract"
    Expand-Archive -Path $archive -DestinationPath $extract
    $runtime = Join-Path $extract "context"
    if (-not (Test-Path (Join-Path $runtime "dist\context.exe"))) { return $false }
    if (Test-Path $installRoot) { Remove-Item -Recurse -Force $installRoot }
    New-Item -ItemType Directory -Force -Path (Split-Path $installRoot) | Out-Null
    Move-Item $runtime $installRoot
    Write-Launcher $installRoot
    $init = @("init", "--targets", $targets, "--create")
    if ($force) { $init += "--force" }
    if (-not $hooks) { $init += "--no-hooks" }
    & (Join-Path $installRoot "dist\context.exe") $init
    return $true
  } catch {
    if ($_.Exception.Message -like "*checksum verification failed*") { throw }
    return $false
  }
}

function Invoke-Uninstall {
  Write-Host "context uninstall (scope: $mode)"
  if ($dryRun) {
    Write-Host "  would remove $installRoot and $binDir\context.cmd"
    return
  }
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $binDir "context.cmd"), (Join-Path $binDir "context.ps1")
  if ($mode -eq "global") {
    if (Test-Path $installRoot) { Remove-Item -Recurse -Force $installRoot }
    Write-Host "context: removed $installRoot"
  }
  Remove-FromPath
  Write-Host "context: done"
}

try {
  if ($uninstall) {
    Invoke-Uninstall
  } elseif ($dryRun) {
    Write-Host "context install (scope: $mode, targets: $targets, platform: windows-x64)"
    Write-Host "  install root: $installRoot"
    Write-Host "  launcher: $binDir\context.cmd"
    if ($mode -eq "global") {
      if ($fromSource) {
        Write-Host "  source install (-FromSource)"
      } else {
        $displayVersion = if ($version) { $version } else { "latest" }
        Write-Host "  release asset: context-$displayVersion-windows-x64.zip (sha256 verified)"
      }
    }
    Write-Host "  hooks: $(if ($hooks) { 'yes' } else { 'no' })"
  } elseif ($mode -eq "local" -or $fromSource) {
    Install-Source
  } elseif (-not (Install-Release)) {
    Write-Warning "context: release unavailable; falling back to source installation"
    Install-Source
  }
  if (-not $uninstall -and -not $dryRun -and $mode -eq "global") {
    Add-ToPath
    Write-Host "context: installed command at $binDir\context.cmd"
    if (Test-Path $legacyRoot) {
      Write-Host "context: note: found legacy install at $legacyRoot; re-run with -Uninstall to clean it up"
    }
  }
} finally {
  if ($temp -and (Test-Path $temp)) { Remove-Item -Recurse -Force $temp }
}

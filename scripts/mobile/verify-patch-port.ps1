<#
.SYNOPSIS
Replays the DSH-Android engine patch sequence against our own built engine artifacts.

.DESCRIPTION
DSH-Android patches the packaged engine (`packages/<group>/<pkg>/lib/*.js`) rather than its
sources, so its `js/patches/*.patch` set is a migration aid, not a delivery mechanism. This
script copies our build output into a scratch `node_modules`, applies every upstream patch in
name order with `git apply -p1`, and reports which ones still land unchanged.

The expected result is recorded in `交付/FustAI-Harness-移动端技术方案-DSH-Android.md` §4.1:
patches 01 02 04 05 06 07 08 09 10 11 12 13 15 19 20 21 apply, and 14 16 17 18 22 fail because
their target `@snnh/dsh-llm-service-lite` does not exist in this repository.

`lib/` is gitignored build output, so run `pnpm run build:artifacts` before this script.

.PARAMETER RepoRoot
Repository root. Defaults to the parent of this script's directory two levels up.

.PARAMETER UpstreamRoot
Checkout of jackwener/DSH-Android. Defaults to `<RepoRoot>/_tmp/DSH-Android`.

.PARAMETER WorkRoot
Scratch directory for the LF-normalised patches and the staging tree. Defaults to `<RepoRoot>/_tmp`.

.PARAMETER Mode
`Sequential` replays the sequence and gates on the expected outcome.
`Cost` prints per-patch size, target files, and whether a source directory exists for porting.

.PARAMETER ExpectedFailures
Patch numbers (first two characters of the file name) that must fail. An empty array asserts 100%.

.EXAMPLE
.\verify-patch-port.ps1

.EXAMPLE
.\verify-patch-port.ps1 -Mode Cost
#>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$UpstreamRoot,
  [string]$WorkRoot,
  [ValidateSet('Sequential', 'Cost')]
  [string]$Mode = 'Sequential',
  [string[]]$ExpectedFailures = @('14', '16', '17', '18', '22')
)

$ErrorActionPreference = 'Continue'

function Fail([string]$Message, [string[]]$Hints) {
  Write-Host ''
  Write-Host "ERROR: $Message" -ForegroundColor Red
  foreach ($h in $Hints) { Write-Host "  - $h" -ForegroundColor Yellow }
  exit 1
}

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
if (-not $UpstreamRoot) { $UpstreamRoot = Join-Path $RepoRoot '_tmp\DSH-Android' }
if (-not $WorkRoot) { $WorkRoot = Join-Path $RepoRoot '_tmp' }

$patchSrc = Join-Path $UpstreamRoot 'js\patches'
if (-not (Test-Path -LiteralPath $patchSrc)) {
  Fail "Upstream patch directory not found: $patchSrc" @(
    'Clone https://github.com/jackwener/DSH-Android into _tmp/DSH-Android, or pass -UpstreamRoot.'
  )
}

$pnpmDir = Join-Path $RepoRoot 'node_modules\.pnpm'
if (-not (Test-Path -LiteralPath $pnpmDir)) {
  Fail "pnpm store not found: $pnpmDir" @('Run pnpm install.')
}

function Resolve-PnpmPackage([string]$Pattern) {
  $hit = Get-ChildItem -LiteralPath $pnpmDir -Directory | Where-Object { $_.Name -like $Pattern } | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  return $null
}

$requireBuiltin = Resolve-PnpmPackage 'node-addon-require-builtin@*'
if (-not $requireBuiltin) {
  Fail 'node-addon-require-builtin is not installed.' @('Run pnpm install.')
}
$sharp = Resolve-PnpmPackage 'sharp@*'
if (-not $sharp) {
  Fail 'sharp is not installed.' @('Run pnpm install.')
}

# Staging path -> our build artifact the patch expects to find there.
$map = [ordered]@{
  '@deepseek-ai/node-addon-system/lib/flock.js'             = "$RepoRoot\native\system\packages\entry\lib\flock.js"
  'node-addon-require-builtin/lib/index.js'                 = "$requireBuiltin\node_modules\node-addon-require-builtin\lib\index.js"
  'sharp/dist/sharp.cjs'                                    = "$sharp\node_modules\sharp\dist\sharp.cjs"
  '@deepseek-ai/dsh-bash-local/lib/index.js'                = "$RepoRoot\packages\shell\bash-local\lib\index.js"
  '@deepseek-ai/dsh-attachment-local/lib/index.js'          = "$RepoRoot\packages\attachment\attachment-local\lib\index.js"
  '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js' = "$RepoRoot\packages\session\session-persistence-jsonl\lib\index.js"
  '@deepseek-ai/dsh-tool-fs-search/lib/index.js'            = "$RepoRoot\packages\fs\tool-fs-search\lib\index.js"
  '@deepseek-ai/dsh-app-boot/lib/index.js'                  = "$RepoRoot\packages\boot\app-boot\lib\index.js"
  '@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js'        = "$RepoRoot\packages\sdk\server\lib\index.js"
  '@deepseek-ai/dsh-spill-local/lib/index.js'               = "$RepoRoot\packages\spill\spill-local\lib\index.js"
  '@deepseek-ai/dsh-http-proxy/lib/index.js'                = "$RepoRoot\packages\util\http-proxy\lib\index.js"
  '@deepseek-ai/dsh-tools/lib/index.js'                     = "$RepoRoot\packages\core\tools\lib\index.js"
  '@deepseek-ai/dsh-commands/lib/index.js'                  = "$RepoRoot\packages\interaction\commands\lib\index.js"
  '@deepseek-ai/dsh-plugin-market/lib/index.js'             = "$RepoRoot\packages\boot\plugin-market\lib\index.js"
  '@snnh/dsh-llm-service-lite/lib/index.js'                 = "$UpstreamRoot\js\packages\llm-service-lite\lib\index.js"
}

$missing = @($map.Keys | Where-Object { -not (Test-Path -LiteralPath $map[$_]) })
if ($missing.Count -gt 0) {
  $details = $missing | ForEach-Object { "  $_ <- $($map[$_])" }
  Fail "Missing staging sources ($($missing.Count)):" @($details + @('Run pnpm run build:artifacts for the packages/ artifacts.'))
}

# --- Cost report -------------------------------------------------------------

# Source directory a patch's target ports into, keyed by staging path.
$srcMap = @{
  '@deepseek-ai/node-addon-system/lib/flock.js'             = 'native\system\packages\entry\src'
  'node-addon-require-builtin/lib/index.js'                 = "$requireBuiltin\node_modules\node-addon-require-builtin\src"
  'sharp/dist/sharp.cjs'                                    = '(third-party dist, no source in this repository)'
  '@deepseek-ai/dsh-bash-local/lib/index.js'                = 'packages\shell\bash-local\src'
  '@deepseek-ai/dsh-attachment-local/lib/index.js'          = 'packages\attachment\attachment-local\src'
  '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js' = 'packages\session\session-persistence-jsonl\src'
  '@deepseek-ai/dsh-tool-fs-search/lib/index.js'            = 'packages\fs\tool-fs-search\src'
  '@deepseek-ai/dsh-app-boot/lib/index.js'                  = 'packages\boot\app-boot\src'
  '@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js'        = 'packages\sdk\server\src'
  '@deepseek-ai/dsh-spill-local/lib/index.js'               = 'packages\spill\spill-local\src'
  '@deepseek-ai/dsh-http-proxy/lib/index.js'                = 'packages\util\http-proxy\src'
  '@deepseek-ai/dsh-tools/lib/index.js'                     = 'packages\core\tools\src'
  '@deepseek-ai/dsh-commands/lib/index.js'                  = 'packages\interaction\commands\src'
  '@deepseek-ai/dsh-plugin-market/lib/index.js'             = 'packages\boot\plugin-market\src'
  '@snnh/dsh-llm-service-lite/lib/index.js'                 = 'NOT IN THIS REPOSITORY'
}

$patches = @(Get-ChildItem -LiteralPath $patchSrc -Filter '*.patch' | Sort-Object Name)
if ($patches.Count -eq 0) {
  Fail "No .patch files under $patchSrc" @('Check the upstream checkout.')
}

function Get-PatchTargets([System.IO.FileInfo]$Patch) {
  $lines = Get-Content -LiteralPath $Patch.FullName
  return @($lines | Where-Object { $_ -match '^\+\+\+ b/' } |
      ForEach-Object { ($_ -replace '^\+\+\+ b/', '') -replace '\s.*$', '' } |
      Select-Object -Unique)
}

if ($Mode -eq 'Cost') {
  $rows = foreach ($p in $patches) {
    $lines = Get-Content -LiteralPath $p.FullName
    $targets = Get-PatchTargets $p
    $srcDirs = @($targets | ForEach-Object { if ($srcMap.ContainsKey($_)) { $srcMap[$_] } else { '?' } } | Select-Object -Unique)
    $present = @($srcDirs | Where-Object { $_ -notmatch '^\(|^NOT IN|^\?' } | ForEach-Object { Test-Path -LiteralPath (Join-Path $RepoRoot $_) })
    [pscustomobject]@{
      Patch  = $p.Name
      Hunks  = @($lines | Where-Object { $_ -match '^@@' }).Count
      Add    = @($lines | Where-Object { $_ -match '^\+' -and $_ -notmatch '^\+\+\+' }).Count
      Del    = @($lines | Where-Object { $_ -match '^-' -and $_ -notmatch '^---' }).Count
      SrcDir = ($srcDirs -join ' ; ')
      HasSrc = if ($present.Count -gt 0 -and $present -notcontains $false) { 'yes' } else { 'no' }
    }
  }
  $rows | Format-Table -AutoSize | Out-String -Width 200
  $applying = @($rows | Where-Object { $ExpectedFailures -notcontains $_.Patch.Substring(0, 2) })
  '--- applying subset: {0} patches, +{1} / -{2} lines ---' -f $applying.Count,
    (($applying | Measure-Object Add -Sum).Sum), (($applying | Measure-Object Del -Sum).Sum)
  exit 0
}

# --- Sequential replay -------------------------------------------------------

$lfDir = Join-Path $WorkRoot 'patches-lf'
$stage = Join-Path $WorkRoot 'patchport'
$nm = Join-Path $stage 'node_modules'

Remove-Item -LiteralPath $stage, $lfDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $nm, $lfDir | Out-Null

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($k in $map.Keys) {
  $dst = Join-Path $nm ($k -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
  Copy-Item -LiteralPath $map[$k] -Destination $dst
}

# The upstream checkout is CRLF; the patch bodies must match LF build output.
foreach ($p in $patches) {
  $text = [System.IO.File]::ReadAllText($p.FullName)
  [System.IO.File]::WriteAllText((Join-Path $lfDir $p.Name), ($text -replace "`r`n", "`n"), $utf8NoBom)
}

& git -C $nm init -q 2>&1 | Out-Null

'=== SEQUENTIAL APPLY (js/build-engine.sh order) ==='
$failed = @()
foreach ($p in (Get-ChildItem -LiteralPath $lfDir -Filter '*.patch' | Sort-Object Name)) {
  $out = & git -C $nm -c core.autocrlf=false apply --check -p1 $p.FullName 2>&1
  if ($LASTEXITCODE -eq 0) {
    & git -C $nm -c core.autocrlf=false apply -p1 $p.FullName 2>&1 | Out-Null
    '{0,-46} OK' -f $p.Name
  } else {
    '{0,-46} FAILED' -f $p.Name
    $out | Where-Object { $_ -match 'error' } | Select-Object -First 3 | ForEach-Object { '      ' + $_ }
    $failed += $p.Name
  }
}

$applied = $patches.Count - $failed.Count
''
'=== RESULT ==='
'{0}/{1} applied sequentially; failed: {2}' -f $applied, $patches.Count, ($failed -join ', ')
$residue = @(Get-ChildItem -LiteralPath $nm -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -eq '.rej' -or $_.Extension -eq '.orig' })
'residue .rej/.orig: ' + $(if ($residue.Count -gt 0) { ($residue | ForEach-Object FullName) -join ',' } else { 'none' })

$actualFailed = @($failed | ForEach-Object { $_.Substring(0, 2) } | Sort-Object)
$wantedFailed = @($ExpectedFailures | Sort-Object)
$sameSet = (($actualFailed -join ',') -eq ($wantedFailed -join ','))

''
if (-not $sameSet) {
  Write-Host "MISMATCH: expected failures [$($wantedFailed -join ', ')], got [$($actualFailed -join ', ')]" -ForegroundColor Red
  exit 1
}
if ($residue.Count -gt 0) {
  Write-Host 'MISMATCH: patch residue left behind' -ForegroundColor Red
  exit 1
}
Write-Host "MATCH: $applied/$($patches.Count) applied; failures [$($wantedFailed -join ', ')] as documented" -ForegroundColor Green
exit 0
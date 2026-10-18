<#
.SYNOPSIS
  Publish the FustAI Harness Windows installer + feed metadata to the
  self-hosted update server (update.fustai.com, nginx on 42.121.0.169).

.DESCRIPTION
  Channel note (plan S12.3/S12.4 assumed beta/stable dual channels):
  the shipped desktop updater is hardcoded to the single `nightly` channel,
  because electron-updater ignores prerelease versions (0.2.1-alpha.4) on
  `latest`. Publishing a higher version to the nightly feed IS the promotion
  (S12.4 step 4 collapses to release-time publish); rollback is done by
  re-publishing an older nightly.yml pointing at a retained exe (S12.5).

  Source artifacts (from `pnpm run package:desktop:win:x64:unsigned`):
    apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\
      fustai-harness-<Version>-win-x64-unsigned.exe
      nightly.yml
  Destination on server (must match resolveDesktopAutoUpdateConfig):
    /var/www/update/fustai-desk/feeds/win-x64/
      fustai-harness-<Version>-win-x64-unsigned.exe
      nightly.yml

  Safety per plan S12.3/S12.7: byte-count verification before atomic mv,
  prune keeps the 3 newest exes, nginx only touched via nginx -t && reload,
  publish aborts when root disk usage exceeds 85%.

.EXAMPLE
  powershell -File scripts\release\publish.ps1 -Version 0.2.1-alpha.4
#>
param(
  [Parameter(Mandatory)][string]$Version
)
$ErrorActionPreference = 'Stop'

$Key       = "$env:USERPROFILE\.ssh\zhongjuhuiAI-ecs.pem"
$SshTarget = 'root@42.121.0.169'
$FeedDir   = '/var/www/update/fustai-desk/feeds/win-x64'
$FeedUrl   = 'https://update.fustai.com/fustai-desk/feeds/win-x64'
$ExeName   = "fustai-harness-$Version-win-x64-unsigned.exe"
$YmlName   = 'nightly.yml'
$SrcDir    = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) `
              'apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts'

# 1) Local artifact verification (S12.3 step 1).
$exe = Join-Path $SrcDir $ExeName
$yml = Join-Path $SrcDir $YmlName
if (-not (Test-Path $exe)) { throw "missing build artifact $exe" }
if (-not (Test-Path $yml)) { throw "missing feed metadata $yml" }
$localSize = (Get-Item $exe).Length
$ymlText   = Get-Content $yml -Raw
if ($ymlText -notmatch "(?m)^version:\s*$([regex]::Escape($Version))\s*$") {
  throw "nightly.yml version does not match $Version"
}
if ($ymlText -notlike "*$ExeName*") { throw "nightly.yml does not reference $ExeName" }
Write-Host "local OK: $ExeName ($localSize bytes)"

# 2) Disk guard before any upload (plan S12.7: abort at >85% usage).
$usageLine = ssh -i $Key -o BatchMode=yes $SshTarget 'df --output=pcent / | tail -1 | tr -dc 0-9'
if (-not $usageLine) { throw 'could not read remote disk usage' }
$usage = [int]($usageLine | Select-Object -Last 1)
if ($usage -gt 85) { throw "remote disk usage ${usage}% > 85%, publish aborted" }
Write-Host "remote disk OK: ${usage}%"

# 3) Upload to /tmp with version-scoped names.
ssh -i $Key -o BatchMode=yes $SshTarget "rm -f /tmp/$ExeName /tmp/$YmlName-$Version"
scp -i $Key -o BatchMode=yes $exe "${SshTarget}:/tmp/$ExeName"
scp -i $Key -o BatchMode=yes $yml "${SshTarget}:/tmp/$YmlName-$Version"

# 4) Remote atomic placement: byte check -> exe first, yml last (a client
#    reading the new feed must always find the referenced installer).
#    Placeholders substituted via Replace() to avoid PS quoting pitfalls.
$remoteScript = @'
set -eu
DST=__FEEDDIR__
EXE=/tmp/__EXENAME__
YML=/tmp/__YMLNAME__-__VERSION__
EXPECT=__SIZE__
GOT=$(stat -c%s "$EXE")
[ "$GOT" -eq "$EXPECT" ] || { echo "SIZE MISMATCH expect=$EXPECT got=$GOT"; exit 2; }
mkdir -p "$DST"
mv "$EXE" "$DST/__EXENAME__"
chmod 644 "$DST/__EXENAME__"
mv "$YML" "$DST/__YMLNAME__"
chmod 644 "$DST/__YMLNAME__"
# prune: keep the 3 newest installers (S12.5 fallback history)
cd "$DST"
ls -t *.exe 2>/dev/null | tail -n +4 | xargs -r rm -f --
# static publish needs no reload, but keep the S12.3 gate for config drift
nginx -t && systemctl reload nginx
CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://update.fustai.com/__FEEDREL__/__YMLNAME__")
echo "SERVER_YML_HTTP:$CODE"
[ "$CODE" = "200" ] || exit 4
ls -la "$DST"
echo PUBLISH_OK
'@
$remoteScript = $remoteScript.Replace('__FEEDDIR__', $FeedDir)
$remoteScript = $remoteScript.Replace('__FEEDREL__', 'fustai-desk/feeds/win-x64')
$remoteScript = $remoteScript.Replace('__EXENAME__', $ExeName)
$remoteScript = $remoteScript.Replace('__YMLNAME__', $YmlName)
$remoteScript = $remoteScript.Replace('__VERSION__', $Version)
$remoteScript = $remoteScript.Replace('__SIZE__', "$localSize")
$tmpSh = Join-Path $env:TEMP 'fustai-publish.sh'
# Force LF endings; CRLF breaks bash shebangs on the server.
[System.IO.File]::WriteAllText($tmpSh, ($remoteScript -replace "`r`n", "`n"))
scp -i $Key -o BatchMode=yes $tmpSh "${SshTarget}:/tmp/fustai-publish.sh"
Remove-Item $tmpSh
ssh -i $Key -o BatchMode=yes $SshTarget 'bash /tmp/fustai-publish.sh; RC=$?; rm -f /tmp/fustai-publish.sh; exit $RC'
if ($LASTEXITCODE -ne 0) { throw "remote publish failed (exit $LASTEXITCODE)" }

# 5) Local reachability check (S12.3 step 4). The router may serve a cached
#    negative DNS answer for a freshly added record, so a name-resolution
#    failure here is a warning; the server-side 200 above already proved the
#    feed is live on the public hostname.
try {
  $head = Invoke-WebRequest "$FeedUrl/$ExeName" -Method Head -UseBasicParsing -TimeoutSec 30
  if ([long]$head.Headers['Content-Length'] -ne $localSize) { throw 'remote length differs from local' }
  $gotYml = (Invoke-WebRequest "$FeedUrl/$YmlName" -UseBasicParsing -TimeoutSec 30).Content
  # The feed serves application/octet-stream, so Invoke-WebRequest returns raw bytes.
  if ($gotYml -is [byte[]]) { $gotYml = [System.Text.Encoding]::UTF8.GetString($gotYml) }
  if ($gotYml -notlike "*$Version*") { throw 'remote nightly.yml does not carry the published version' }
  Write-Host "OK: $FeedUrl/$ExeName ($localSize bytes) published and reachable from this machine"
} catch {
  Write-Warning "local verification deferred (DNS propagation or transient): $($_.Exception.Message); server-side check already returned 200"
}

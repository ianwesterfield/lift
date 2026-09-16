# deploy.ps1 — build, test, and deploy both scripts to the Shelly Pro 3 "Lift".
#
# Ordering matters: the watchdog (script 2) restarts the arbiter (script 1) if
# it sees it stopped, so the watchdog MUST be stopped first or it can start the
# arbiter mid-upload with partial code.
#
# Usage: .\deploy.ps1 [-DeviceIp 192.168.40.105] [-SkipTests]

param(
    [string]$DeviceIp = "192.168.40.105",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$base = "http://$DeviceIp/rpc"
$repo = $PSScriptRoot

$ARBITER_ID = 1
$WATCHDOG_ID = 2

function Invoke-Rpc {
    param([string]$Method, [hashtable]$Params = @{})
    $body = @{ id = 1; method = $Method; params = $Params } | ConvertTo-Json -Depth 6
    $response = Invoke-RestMethod -Uri $base -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
    if ($response.error) { throw "$Method failed: $($response.error | ConvertTo-Json -Compress)" }
    return $response.result
}

function Push-Script {
    param([int]$Id, [string]$Path, [string]$Name)
    $code = Get-Content $Path -Raw
    Write-Host "  uploading $Name ($($code.Length) chars) to script $Id..."

    # chunked PutCode: first chunk replaces, the rest append
    $chunkSize = 1024
    $offset = 0
    while ($offset -lt $code.Length) {
        $length = [Math]::Min($chunkSize, $code.Length - $offset)
        $chunk = $code.Substring($offset, $length)
        Invoke-Rpc "Script.PutCode" @{ id = $Id; code = $chunk; append = ($offset -gt 0) } | Out-Null
        $offset += $length
    }
}

# ---- build + test gate ----

Push-Location $repo
try {
    Write-Host "== build =="
    npx tsc
    if ($LASTEXITCODE -ne 0) { throw "tsc failed" }

    if (-not $SkipTests) {
        Write-Host "== tests =="
        node test\run-tests.js
        if ($LASTEXITCODE -ne 0) { throw "tests failed — not deploying" }
    }

    # ---- deploy (watchdog-safe ordering) ----

    Write-Host "== deploy to $DeviceIp =="

    Write-Host "  stopping watchdog (script $WATCHDOG_ID) first..."
    try { Invoke-Rpc "Script.Stop" @{ id = $WATCHDOG_ID } | Out-Null } catch { Write-Host "  (watchdog was not running)" }

    Write-Host "  stopping arbiter (script $ARBITER_ID)..."
    try { Invoke-Rpc "Script.Stop" @{ id = $ARBITER_ID } | Out-Null } catch { Write-Host "  (arbiter was not running)" }

    Push-Script -Id $ARBITER_ID -Path "$repo\scripts\lift-arbiter.js" -Name "lift-arbiter"
    Invoke-Rpc "Script.Start" @{ id = $ARBITER_ID } | Out-Null
    Write-Host "  arbiter started"

    Push-Script -Id $WATCHDOG_ID -Path "$repo\scripts\watchdog.js" -Name "watchdog"
    Invoke-Rpc "Script.SetConfig" @{ id = $WATCHDOG_ID; config = @{ enable = $true } } | Out-Null
    Invoke-Rpc "Script.Start" @{ id = $WATCHDOG_ID } | Out-Null
    Write-Host "  watchdog started"

    # ---- verify ----

    Write-Host "== verify =="
    Start-Sleep -Seconds 2

    $scripts = Invoke-Rpc "Script.List"
    foreach ($script in $scripts.scripts) {
        Write-Host ("  script {0} '{1}' running={2}" -f $script.id, $script.name, $script.running)
    }

    $status = Invoke-RestMethod -Uri "http://$DeviceIp/script/$ARBITER_ID/lift?cmd=hist" -TimeoutSec 10
    $banner = $status.hist | Where-Object { $_ -match "armed" } | Select-Object -Last 1
    if (-not $banner) { throw "no boot banner in history — arbiter may not have initialized" }
    Write-Host "  boot banner: $banner"
    Write-Host "  state=$($status.state) pos=$($status.pos) pct=$($status.pct)"

    Write-Host "== deployed OK =="
}
finally {
    Pop-Location
}

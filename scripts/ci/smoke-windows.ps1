# Launches the app in smoke-test mode (AIC_SMOKE_TEST=1) and fails unless it reports ok.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Report
)
$ErrorActionPreference = 'Stop'
$reportPath = Join-Path (Get-Location) $Report
Remove-Item $reportPath -ErrorAction SilentlyContinue
$env:AIC_SMOKE_TEST = '1'
$env:AIC_SMOKE_TEST_OUT = $reportPath
try {
  $p = Start-Process -FilePath $Exe -PassThru
  if (-not $p.WaitForExit(90000)) {
    Stop-Process -Id $p.Id -Force
    throw 'Smoke test timed out after 90 s'
  }
} finally {
  Remove-Item Env:AIC_SMOKE_TEST, Env:AIC_SMOKE_TEST_OUT -ErrorAction SilentlyContinue
}
if (-not (Test-Path $reportPath)) { throw "No smoke report (exit code $($p.ExitCode))" }
$json = Get-Content $reportPath -Raw
Write-Host $json
$result = $json | ConvertFrom-Json
if (-not $result.ok) { throw 'Smoke test failed' }
if ($result.secureStorage -ne 'os') { throw "Expected OS secure storage, got $($result.secureStorage)" }
Write-Host "Smoke test passed in $($result.elapsedMs) ms"

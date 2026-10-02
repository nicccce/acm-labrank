param(
  [string]$Handle = 'tourist',
  [string]$CheckpointHandle = 'MikeMirzayanov',
  [int]$Port = 55433
)
$ErrorActionPreference = 'Stop'
$cfRepoRoot = Split-Path $PSScriptRoot -Parent
$cfContainer = 'acm-cf-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$cfPassword = [guid]::NewGuid().ToString('N')
$cfOriginalDatabaseUrl = $env:DATABASE_URL
$cfOriginalPath = $env:Path
$cfOriginalLocation = Get-Location
$cfStateDir = Join-Path $cfRepoRoot ('.local/cf-verify-' + [guid]::NewGuid().ToString('N'))
$cfUtf8 = [Text.UTF8Encoding]::new($false)

function Invoke-CfRead([string[]]$ReadArguments) {
  $cfLines = @(& pnpm cf:read @ReadArguments)
  $cfExit = $LASTEXITCODE
  $cfLines | ForEach-Object { Write-Host $_ }
  if ($cfExit -ne 0) { throw 'Codeforces Worker verification failed' }
  $cfJson = $cfLines | Where-Object { $_ -match '^\{"event":"codeforces_account_read"' } | Select-Object -Last 1
  if (!$cfJson) { throw 'Missing Worker JSON result' }
  return $cfJson | ConvertFrom-Json
}

try {
  Set-Location $cfRepoRoot
  $cfNodeDir = Join-Path $cfRepoRoot '../.local/runtime/node_modules/node/bin'
  if (Test-Path (Join-Path $cfNodeDir 'node.exe')) { $env:Path = "$cfNodeDir;$env:Path" }
  if ((& node --version) -notmatch '^v24\.') { throw 'Verification requires Node.js 24' }
  New-Item -ItemType Directory -Path $cfStateDir | Out-Null
  & docker run -d --rm --name $cfContainer -p "127.0.0.1:${Port}:5432" -e POSTGRES_USER=cf_verify -e POSTGRES_DB=cf_verify -e "POSTGRES_PASSWORD=$cfPassword" postgres:17.11-bookworm
  if ($LASTEXITCODE -ne 0) { throw 'Unable to start empty verification database' }
  $cfReady = $false
  for ($cfTry = 0; $cfTry -lt 60; $cfTry++) {
    & docker exec $cfContainer pg_isready -U cf_verify -d cf_verify *> $null
    if ($LASTEXITCODE -eq 0) { $cfReady = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (!$cfReady) { throw 'Verification database did not become ready' }
  $env:DATABASE_URL = "postgresql://cf_verify:${cfPassword}@127.0.0.1:${Port}/cf_verify"
  & pnpm db:migrate
  if ($LASTEXITCODE -ne 0) { throw 'Verification migration failed' }
  & pnpm cf:lease-probe
  if ($LASTEXITCODE -ne 0) { throw 'Shared PostgreSQL lease probe failed' }
  $cfBackfill = Invoke-CfRead @('--handle', $Handle, '--mode', 'backfill', '--page-size', '5', '--max-pages', '2', '--with-profile', '--with-rating')
  if ($cfBackfill.pages -ne 2) { throw 'The chosen handle must expose at least two pages for this probe' }

  # A checkpoint must come from a completed real scan; never construct one for the smoke test.
  $cfCursorFile = Join-Path $cfStateDir 'cursor.json'
  $cfCheckpointFile = Join-Path $cfStateDir 'checkpoint.json'
  $cfArguments = @('--handle', $CheckpointHandle, '--mode', 'incremental', '--page-size', '100', '--max-pages', '10')
  for ($cfRound = 0; $cfRound -lt 5; $cfRound++) {
    $cfScan = Invoke-CfRead $cfArguments
    if ($cfScan.checkpoint) { break }
    if (!$cfScan.cursor) { throw 'Real scan returned neither cursor nor checkpoint' }
    [IO.File]::WriteAllText($cfCursorFile, ($cfScan.cursor | ConvertTo-Json -Depth 20 -Compress), $cfUtf8)
    $cfArguments = @('--handle', $CheckpointHandle, '--mode', 'incremental', '--max-pages', '10', '--cursor', $cfCursorFile)
  }
  if (!$cfScan.checkpoint) { throw 'Initial incremental scan did not finish within five bounded batches' }
  [IO.File]::WriteAllText($cfCheckpointFile, ($cfScan.checkpoint | ConvertTo-Json -Depth 20 -Compress), $cfUtf8)
  $cfIncremental = Invoke-CfRead @('--handle', $CheckpointHandle, '--mode', 'incremental', '--page-size', '100', '--max-pages', '10', '--checkpoint', $cfCheckpointFile)
  if ($cfIncremental.batchStatus -ne 'complete' -or !$cfIncremental.checkpoint) { throw 'Checkpoint-based incremental scan did not finish' }
  Write-Host ([ordered]@{ event = 'codeforces_live_verification_passed'; observedAt = [DateTimeOffset]::UtcNow.ToString('o'); backfillPages = $cfBackfill.pages; backfillRawRecords = $cfBackfill.rawRecordCount; backfillUniqueRecords = $cfBackfill.uniqueRecordCount; initialScanPagesInFinalBatch = $cfScan.pages; incrementalPages = $cfIncremental.pages; incrementalStopReason = $cfIncremental.stopReason } | ConvertTo-Json -Compress)
} finally {
  $env:DATABASE_URL = $cfOriginalDatabaseUrl
  $env:Path = $cfOriginalPath
  & docker stop $cfContainer | Out-Null
  # Remove only the two known protocol files and their exact temporary directory.
  foreach ($cfFile in @('cursor.json', 'checkpoint.json')) {
    $cfKnownFile = Join-Path $cfStateDir $cfFile
    if (Test-Path -LiteralPath $cfKnownFile) { Remove-Item -LiteralPath $cfKnownFile }
  }
  if (Test-Path -LiteralPath $cfStateDir) { Remove-Item -LiteralPath $cfStateDir }
  Set-Location $cfOriginalLocation
}

[CmdletBinding()]
param(
    [ValidateSet('doctor', 'run', 'status', 'backfill')][string]$Mode = 'run',
    [string]$EnvFile = '.env',
    [string]$DataDirectory = '',
    [string]$LogDirectory = '',
    [string]$PnpmPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'SnapMeter.Common.psm1') -Force
$repositoryRoot = Get-SnapMeterRepositoryRoot
$environment = Import-SnapMeterEnvironment -Path $EnvFile
Test-SnapMeterConfiguration -RequireCloud:($Mode -eq 'run')

$resolvedData = Get-SnapMeterDataDirectory -Override $DataDirectory
$resolvedLog = if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
    Join-Path $resolvedData 'logs'
} else {
    Resolve-SnapMeterPath -Path $LogDirectory
}
[void](Initialize-SnapMeterDirectory -Path $resolvedData)
[void](Initialize-SnapMeterDirectory -Path $resolvedLog)
$env:SNAPMETER_DATA_DIR = $resolvedData

$logRetentionDays = 14
if (-not [string]::IsNullOrWhiteSpace($env:SNAPMETER_LOG_RETENTION_DAYS)) {
    $parsedRetention = 0
    if (-not [int]::TryParse($env:SNAPMETER_LOG_RETENTION_DAYS, [ref]$parsedRetention) -or
        $parsedRetention -lt 1 -or
        $parsedRetention -gt 365) {
        throw 'SNAPMETER_LOG_RETENTION_DAYS must be an integer from 1 through 365.'
    }
    $logRetentionDays = $parsedRetention
}
$logRoot = [System.IO.Path]::GetFullPath($resolvedLog).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$logCutoff = (Get-Date).ToUniversalTime().AddDays(-$logRetentionDays)
$removedLogs = 0
foreach ($oldLog in Get-ChildItem -LiteralPath $resolvedLog -Filter 'collector-*.log' -File -ErrorAction SilentlyContinue) {
    $oldLogPath = [System.IO.Path]::GetFullPath($oldLog.FullName)
    if (-not $oldLogPath.StartsWith($logRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing log cleanup because a resolved file escaped the configured log directory.'
    }
    if ($oldLog.LastWriteTimeUtc -lt $logCutoff) {
        Remove-Item -LiteralPath $oldLogPath -Force
        $removedLogs += 1
    }
}
if ($removedLogs -gt 0) {
    Write-Host "Removed $removedLogs expired collector log file(s); these files are not recoverable from the log directory."
}

$resolvedPnpm = if ([string]::IsNullOrWhiteSpace($PnpmPath)) {
    Get-SnapMeterCommandPath -Names @('pnpm.cmd', 'pnpm')
} else {
    Resolve-SnapMeterPath -Path $PnpmPath -MustExist
}

$logPath = Join-Path $resolvedLog ("collector-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
$header = [pscustomobject]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    level = 'info'
    component = 'windows-runner'
    event = 'collector-start'
    mode = $Mode
    environmentFile = $environment.Path
    dataDirectory = $resolvedData
}
$headerLine = $header | ConvertTo-Json -Compress
Add-Content -LiteralPath $logPath -Value $headerLine
Write-Host $headerLine

$nativeExitCode = 1
Push-Location $repositoryRoot
try {
    & $resolvedPnpm collector $Mode 2>&1 | ForEach-Object {
        $line = Protect-SnapMeterText -InputObject $_
        Add-Content -LiteralPath $logPath -Value $line
        Write-Output $line
    }
    $nativeExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($nativeExitCode -ne 0) {
    throw "Collector $Mode exited with code $nativeExitCode. See the redacted log at $logPath."
}

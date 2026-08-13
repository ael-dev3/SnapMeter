[CmdletBinding()]
param(
    [string]$EnvFile = '.env',
    [switch]$SkipDoctor
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'SnapMeter.Common.psm1') -Force

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'bootstrap.ps1 is intended for Windows. Use pnpm install directly on other platforms.'
}

$repositoryRoot = Get-SnapMeterRepositoryRoot
$resolvedEnv = Resolve-SnapMeterPath -Path $EnvFile
if (-not (Test-Path -LiteralPath $resolvedEnv -PathType Leaf)) {
    $example = Join-Path $repositoryRoot '.env.example'
    if (-not (Test-Path -LiteralPath $example -PathType Leaf)) {
        throw '.env.example is missing.'
    }
    Copy-Item -LiteralPath $example -Destination $resolvedEnv
    Write-Host "Created $resolvedEnv from .env.example. Configure it before a continuous run."
}

[void](Import-SnapMeterEnvironment -Path $resolvedEnv)
Test-SnapMeterConfiguration

$nodePath = Get-SnapMeterCommandPath -Names @('node.exe', 'node')
$pnpmPath = Get-SnapMeterCommandPath -Names @('pnpm.cmd', 'pnpm')
$nodeVersionText = (& $nodePath --version).TrimStart('v')
$nodeVersion = $null
if (-not [Version]::TryParse($nodeVersionText, [ref]$nodeVersion) -or $nodeVersion.Major -lt 24) {
    throw "Node.js 24 or later is required; found $nodeVersionText."
}
$pnpmVersionText = (& $pnpmPath --version).Trim()
$pnpmVersion = $null
if (-not [Version]::TryParse($pnpmVersionText, [ref]$pnpmVersion) -or $pnpmVersion.Major -lt 11) {
    throw "pnpm 11 or later is required; found $pnpmVersionText."
}

$dataDirectory = Get-SnapMeterDataDirectory
$logDirectory = Join-Path $dataDirectory 'logs'
[void](Initialize-SnapMeterDirectory -Path $dataDirectory)
[void](Initialize-SnapMeterDirectory -Path $logDirectory)
$env:SNAPMETER_DATA_DIR = $dataDirectory

foreach ($source in @(
    @{ Name = 'Snapchain'; Value = $env:SNAPCHAIN_GRPC_URL },
    @{ Name = 'Hypersnap'; Value = $env:HYPERSNAP_GRPC_URL }
)) {
    $endpoint = Get-SnapMeterEndpoint -Value $source.Value
    $reachable = Test-NetConnection -ComputerName $endpoint.Host -Port $endpoint.Port -InformationLevel Quiet -WarningAction SilentlyContinue
    $unreachableMessage = if ($source.Name -eq 'Hypersnap' -and -not [string]::IsNullOrWhiteSpace($env:HYPERSNAP_FALLBACK_HTTP_URL)) {
        'not reachable; doctor will try the configured HTTPS fallback'
    } else {
        'not reachable; doctor will report source unavailable'
    }
    Write-Host ("{0} TCP probe: {1}" -f $source.Name, $(if ($reachable) { 'reachable' } else { $unreachableMessage }))
}

if (-not [string]::IsNullOrWhiteSpace($env:HYPERSNAP_FALLBACK_HTTP_URL)) {
    try {
        $fallbackInfoUri = Get-SnapMeterHypersnapInfoUri -Value $env:HYPERSNAP_FALLBACK_HTTP_URL
        $fallbackResponse = Invoke-WebRequest -Uri $fallbackInfoUri -Method Get -Headers @{ Accept = 'application/json' } -MaximumRedirection 0 -TimeoutSec 15 -UseBasicParsing
        $fallbackReachable = $fallbackResponse.StatusCode -ge 200 -and $fallbackResponse.StatusCode -lt 300
        Write-Host ("Hypersnap HTTPS fallback probe: {0}" -f $(if ($fallbackReachable) { 'reachable' } else { 'not reachable; doctor will report compatibility details' }))
    } catch {
        Write-Host 'Hypersnap HTTPS fallback probe: not reachable; doctor will report compatibility details'
    }
}

$lockFile = Join-Path $repositoryRoot 'pnpm-lock.yaml'
if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) {
    throw 'pnpm-lock.yaml is missing. Refusing an unpinned bootstrap install.'
}

Push-Location $repositoryRoot
try {
    & $pnpmPath install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install failed with exit code $LASTEXITCODE."
    }

    if (-not $SkipDoctor) {
        & $pnpmPath collector doctor 2>&1 | ForEach-Object {
            Write-Output (Protect-SnapMeterText -InputObject $_)
        }
        $doctorExitCode = $LASTEXITCODE
        if ($doctorExitCode -ne 0) {
            throw "Collector doctor failed with exit code $doctorExitCode. No node was launched or reconfigured."
        }
    }
} finally {
    Pop-Location
}

Write-Host "Bootstrap complete. Data directory: $dataDirectory"

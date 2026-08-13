[CmdletBinding()]
param(
    [string]$EnvFile = '.env',
    [string]$PublicStatusUrl = '',
    [switch]$SkipCloud
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'SnapMeter.Common.psm1') -Force
$repositoryRoot = Get-SnapMeterRepositoryRoot
[void](Import-SnapMeterEnvironment -Path $EnvFile)
Test-SnapMeterConfiguration
$pnpmPath = Get-SnapMeterCommandPath -Names @('pnpm.cmd', 'pnpm')

$failures = [System.Collections.Generic.List[string]]::new()

$snapchainEndpoint = Get-SnapMeterEndpoint -Value $env:SNAPCHAIN_GRPC_URL
$snapchainReachable = Test-NetConnection -ComputerName $snapchainEndpoint.Host -Port $snapchainEndpoint.Port -InformationLevel Quiet -WarningAction SilentlyContinue
Write-Host ("Snapchain TCP: {0}" -f $(if ($snapchainReachable) { 'reachable' } else { 'unreachable' }))
if (-not $snapchainReachable -and $env:SNAPCHAIN_SOURCE_MODE -ne 'unavailable') {
    $failures.Add('Snapchain TCP endpoint is unreachable')
}

$hypersnapEndpoint = Get-SnapMeterEndpoint -Value $env:HYPERSNAP_GRPC_URL
$hypersnapPrimaryReachable = Test-NetConnection -ComputerName $hypersnapEndpoint.Host -Port $hypersnapEndpoint.Port -InformationLevel Quiet -WarningAction SilentlyContinue
Write-Host ("Hypersnap primary TCP: {0}" -f $(if ($hypersnapPrimaryReachable) { 'reachable' } else { 'unreachable' }))

$hypersnapFallbackConfigured = -not [string]::IsNullOrWhiteSpace($env:HYPERSNAP_FALLBACK_HTTP_URL)
$hypersnapFallbackReachable = $false
if ($hypersnapFallbackConfigured) {
    try {
        $fallbackInfoUri = Get-SnapMeterHypersnapInfoUri -Value $env:HYPERSNAP_FALLBACK_HTTP_URL
        $fallbackResponse = Invoke-WebRequest -Uri $fallbackInfoUri -Method Get -Headers @{ Accept = 'application/json' } -MaximumRedirection 0 -TimeoutSec 15 -UseBasicParsing
        $hypersnapFallbackReachable = $fallbackResponse.StatusCode -ge 200 -and $fallbackResponse.StatusCode -lt 300
    } catch {
        $hypersnapFallbackReachable = $false
    }
    Write-Host ("Hypersnap HTTPS fallback: {0}" -f $(if ($hypersnapFallbackReachable) { 'reachable' } else { 'unreachable' }))
}

$hypersnapMode = if ([string]::IsNullOrWhiteSpace($env:HYPERSNAP_SOURCE_MODE)) { 'derived' } else { $env:HYPERSNAP_SOURCE_MODE.ToLowerInvariant() }
if ($hypersnapMode -ne 'unavailable' -and -not $hypersnapPrimaryReachable -and -not $hypersnapFallbackReachable) {
    $failures.Add('No reachable Hypersnap primary or HTTPS fallback was found')
} elseif ($hypersnapFallbackConfigured -and -not $hypersnapFallbackReachable) {
    Write-Warning 'Hypersnap fallback is unreachable; collection can continue only while the preferred endpoint remains healthy.'
}

Push-Location $repositoryRoot
try {
    & $pnpmPath collector doctor 2>&1 | ForEach-Object {
        Write-Output (Protect-SnapMeterText -InputObject $_)
    }
    $doctorExitCode = $LASTEXITCODE
    if ($doctorExitCode -ne 0) {
        $failures.Add("collector doctor exited with code $doctorExitCode")
    }
    & $pnpmPath collector status 2>&1 | ForEach-Object {
        Write-Output (Protect-SnapMeterText -InputObject $_)
    }
    $statusExitCode = $LASTEXITCODE
    if ($statusExitCode -ne 0) {
        $failures.Add("collector status exited with code $statusExitCode")
    }
} finally {
    Pop-Location
}

if (-not $SkipCloud) {
    $candidate = $PublicStatusUrl
    if ([string]::IsNullOrWhiteSpace($candidate) -and -not [string]::IsNullOrWhiteSpace($env:SNAPMETER_INGEST_URL)) {
        $ingest = [Uri]$env:SNAPMETER_INGEST_URL
        if ($ingest.AbsolutePath.EndsWith('/api/v1/ingest/batch', [StringComparison]::OrdinalIgnoreCase)) {
            $builder = [UriBuilder]$ingest
            $builder.Path = '/api/v1/status'
            $builder.Query = ''
            $candidate = $builder.Uri.AbsoluteUri
        }
    }

    if ([string]::IsNullOrWhiteSpace($candidate)) {
        Write-Warning 'Cloud status was not checked because no public status URL could be derived.'
    } else {
        [Uri]$statusUri = $null
        if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$statusUri) -or
            $statusUri.Scheme -ne 'https' -or
            -not [string]::IsNullOrEmpty($statusUri.UserInfo)) {
            $failures.Add('public status URL must be absolute HTTPS without credentials')
        } else {
            try {
                $response = Invoke-WebRequest -Uri $statusUri -Method Get -TimeoutSec 15 -UseBasicParsing
                Write-Host "Cloud status HTTP: $($response.StatusCode)"
                if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
                    $failures.Add("cloud status returned HTTP $($response.StatusCode)")
                }
            } catch {
                $failures.Add('cloud status request failed; details omitted to avoid leaking endpoint data')
            }
        }
    }
}

if ($failures.Count -gt 0) {
    foreach ($failure in $failures) {
        Write-Error $failure
    }
    exit 1
}

Write-Host 'Health checks completed successfully. Source quality still depends on the detailed doctor/status output.'

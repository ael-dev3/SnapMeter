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
foreach ($source in @(
    @{ Name = 'Snapchain'; Value = $env:SNAPCHAIN_GRPC_URL },
    @{ Name = 'Hypersnap'; Value = $env:HYPERSNAP_GRPC_URL }
)) {
    $endpoint = Get-SnapMeterEndpoint -Value $source.Value
    $reachable = Test-NetConnection -ComputerName $endpoint.Host -Port $endpoint.Port -InformationLevel Quiet -WarningAction SilentlyContinue
    Write-Host ("{0} TCP: {1}" -f $source.Name, $(if ($reachable) { 'reachable' } else { 'unreachable' }))
    if (-not $reachable) {
        $failures.Add("$($source.Name) TCP endpoint is unreachable")
    }
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

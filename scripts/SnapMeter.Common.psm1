Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-SnapMeterRepositoryRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Resolve-SnapMeterPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$BasePath = (Get-SnapMeterRepositoryRoot),
        [switch]$MustExist
    )

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if ([string]::IsNullOrWhiteSpace($expanded)) {
        throw 'A required path was empty.'
    }

    $candidate = if ([System.IO.Path]::IsPathRooted($expanded)) {
        $expanded
    } else {
        Join-Path $BasePath $expanded
    }

    $fullPath = [System.IO.Path]::GetFullPath($candidate)
    if ($MustExist -and -not (Test-Path -LiteralPath $fullPath)) {
        throw "Required path does not exist: $fullPath"
    }
    return $fullPath
}

function Import-SnapMeterEnvironment {
    param([Parameter(Mandatory = $true)][string]$Path)

    $envPath = Resolve-SnapMeterPath -Path $Path -MustExist
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $acl = Get-Acl -LiteralPath $envPath
        $unsafeRules = @($acl.Access | Where-Object {
            $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            $_.IdentityReference.Value -match '(?i)(?:^|\\)(Everyone|Users|Authenticated Users)$' -and
            ($_.FileSystemRights -band (
                [System.Security.AccessControl.FileSystemRights]::Read -bor
                [System.Security.AccessControl.FileSystemRights]::ReadData -bor
                [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
                [System.Security.AccessControl.FileSystemRights]::FullControl
            )) -ne 0
        })
        if ($unsafeRules.Count -gt 0) {
            throw "Environment file permissions are too broad: $envPath. Restrict read access to the collector account and administrators."
        }
    }
    $loadedNames = [System.Collections.Generic.List[string]]::new()

    foreach ($rawLine in [System.IO.File]::ReadAllLines($envPath)) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith('#')) {
            continue
        }

        $match = [regex]::Match($line, '^(?:export\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$')
        if (-not $match.Success) {
            throw "Malformed environment entry in $envPath. Expected NAME=value; values were not printed."
        }

        $name = $match.Groups['name'].Value
        if ($name -notmatch '^(?:SNAPMETER|SNAPCHAIN|HYPERSNAP)_[A-Z0-9_]+$') {
            throw "Unsupported environment name in $envPath. Only SnapMeter and source-specific variables are allowed."
        }
        $value = $match.Groups['value'].Value.Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }

        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        $loadedNames.Add($name)
    }

    return [pscustomobject]@{
        Path = $envPath
        Names = $loadedNames.ToArray()
    }
}

function Get-SnapMeterEndpoint {
    param([Parameter(Mandatory = $true)][string]$Value)

    $match = [regex]::Match($Value.Trim(), '^(?:\[(?<ipv6>[^\]\s]+)\]|(?<host>[^:/\\@?#\s]+)):(?<port>[0-9]{1,5})$')
    if (-not $match.Success) {
        throw 'gRPC endpoint must be host:port without a URL scheme or credentials.'
    }

    $port = [int]$match.Groups['port'].Value
    if ($port -lt 1 -or $port -gt 65535) {
        throw 'gRPC endpoint port must be between 1 and 65535.'
    }

    $hostName = if ($match.Groups['ipv6'].Success) {
        $match.Groups['ipv6'].Value
    } else {
        $match.Groups['host'].Value
    }

    return [pscustomobject]@{ Host = $hostName; Port = $port }
}

function Test-SnapMeterBooleanValue {
    param([AllowEmptyString()][string]$Value, [string]$Name)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    if ($Value.ToLowerInvariant() -notin @('true', 'false', '1', '0', 'yes', 'no', 'on', 'off')) {
        throw "$Name must be true/false, yes/no, on/off, or 1/0."
    }
}

function Test-SnapMeterIntegerValue {
    param(
        [AllowEmptyString()][string]$Value,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][long]$Minimum,
        [Parameter(Mandatory = $true)][long]$Maximum
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    $parsed = 0L
    if (-not [long]::TryParse($Value, [ref]$parsed) -or $parsed -lt $Minimum -or $parsed -gt $Maximum) {
        throw "$Name must be an integer from $Minimum through $Maximum."
    }
}

function Get-SnapMeterHttpsUri {
    param([Parameter(Mandatory = $true)][string]$Value, [string]$Name = 'HTTPS URL')

    [Uri]$uri = $null
    if (-not [Uri]::TryCreate($Value.Trim(), [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or
        [string]::IsNullOrWhiteSpace($uri.Host) -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "$Name must be an absolute HTTPS URL without credentials, a query, or a fragment."
    }
    return $uri
}

function Test-SnapMeterPeerIdValue {
    param([AllowEmptyString()][string]$Value, [Parameter(Mandatory = $true)][string]$Name)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    $normalized = $Value.Trim()
    if ($normalized.Length -gt 128 -or $normalized -notmatch '^[1-9A-HJ-NP-Za-km-z]+$') {
        throw "$Name must be a base58 peer identifier no longer than 128 characters."
    }
}

function Test-SnapMeterVersionValue {
    param([AllowEmptyString()][string]$Value, [Parameter(Mandatory = $true)][string]$Name)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    $normalized = $Value.Trim()
    if ($normalized.Length -gt 64 -or $normalized -notmatch '^[0-9A-Za-z][0-9A-Za-z._/+:-]*$') {
        throw "$Name contains an invalid version identifier."
    }
}

function Get-SnapMeterHypersnapInfoUri {
    param([Parameter(Mandatory = $true)][string]$Value)

    $baseUri = Get-SnapMeterHttpsUri -Value $Value -Name 'HYPERSNAP_FALLBACK_HTTP_URL'
    $builder = [UriBuilder]::new($baseUri)
    if (-not $builder.Path.EndsWith('/')) {
        $builder.Path += '/'
    }
    return [Uri]::new($builder.Uri, 'v1/info')
}

function Test-SnapMeterConfiguration {
    param([switch]$RequireCloud)

    foreach ($name in @('SNAPCHAIN_GRPC_URL', 'HYPERSNAP_GRPC_URL')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "$name is required."
        }
        [void](Get-SnapMeterEndpoint -Value $value)
    }

    Test-SnapMeterBooleanValue -Value $env:SNAPCHAIN_GRPC_TLS -Name 'SNAPCHAIN_GRPC_TLS'
    Test-SnapMeterBooleanValue -Value $env:HYPERSNAP_GRPC_TLS -Name 'HYPERSNAP_GRPC_TLS'
    foreach ($rule in @(
        @{ Name = 'SNAPMETER_RPC_TIMEOUT_MS'; Minimum = 250L; Maximum = 120000L },
        @{ Name = 'SNAPCHAIN_RPC_TIMEOUT_MS'; Minimum = 250L; Maximum = 120000L },
        @{ Name = 'HYPERSNAP_RPC_TIMEOUT_MS'; Minimum = 250L; Maximum = 120000L },
        @{ Name = 'SNAPCHAIN_RPC_MIN_INTERVAL_MS'; Minimum = 0L; Maximum = 3600000L },
        @{ Name = 'HYPERSNAP_RPC_MIN_INTERVAL_MS'; Minimum = 0L; Maximum = 3600000L },
        @{ Name = 'HYPERSNAP_FALLBACK_RPC_MIN_INTERVAL_MS'; Minimum = 0L; Maximum = 3600000L },
        @{ Name = 'HYPERSNAP_FALLBACK_POLL_INTERVAL_MS'; Minimum = 250L; Maximum = 60000L },
        @{ Name = 'HYPERSNAP_FAILOVER_AFTER_FAILURES'; Minimum = 1L; Maximum = 100L },
        @{ Name = 'HYPERSNAP_PREFERRED_RECOVERY_INTERVAL_MS'; Minimum = 5000L; Maximum = 3600000L },
        @{ Name = 'HYPERSNAP_PREFERRED_RECOVERY_SUCCESSES'; Minimum = 1L; Maximum = 100L },
        @{ Name = 'HYPERSNAP_MAX_BLOCK_DELAY_SECONDS'; Minimum = 0L; Maximum = 86400L },
        @{ Name = 'SNAPMETER_RECONCILE_INTERVAL_MS'; Minimum = 1000L; Maximum = 3600000L },
        @{ Name = 'SNAPMETER_DISCOVERY_INTERVAL_MS'; Minimum = 5000L; Maximum = 3600000L },
        @{ Name = 'SNAPMETER_SNAPSHOT_INTERVAL_MS'; Minimum = 1000L; Maximum = 300000L },
        @{ Name = 'SNAPMETER_PULSE_INTERVAL_MS'; Minimum = 100L; Maximum = 5000L },
        @{ Name = 'SNAPMETER_RETENTION_DAYS'; Minimum = 31L; Maximum = 365L },
        @{ Name = 'SNAPMETER_BACKFILL_DAYS'; Minimum = 31L; Maximum = 365L },
        @{ Name = 'SNAPMETER_STALE_AFTER_MS'; Minimum = 5000L; Maximum = 3600000L },
        @{ Name = 'SNAPMETER_DISCONNECTED_AFTER_MS'; Minimum = 10000L; Maximum = 86400000L },
        @{ Name = 'SNAPMETER_MAX_OUTBOX_ROWS'; Minimum = 100L; Maximum = 100000L },
        @{ Name = 'SNAPMETER_MIN_FREE_DISK_BYTES'; Minimum = 1L; Maximum = 9007199254740991L },
        @{ Name = 'SNAPMETER_LOG_RETENTION_DAYS'; Minimum = 1L; Maximum = 365L }
    )) {
        $configuredValue = [Environment]::GetEnvironmentVariable($rule.Name, 'Process')
        Test-SnapMeterIntegerValue -Value $configuredValue -Name $rule.Name -Minimum $rule.Minimum -Maximum $rule.Maximum
    }

    Test-SnapMeterPeerIdValue -Value $env:SNAPCHAIN_EXPECTED_PEER_ID -Name 'SNAPCHAIN_EXPECTED_PEER_ID'
    Test-SnapMeterPeerIdValue -Value $env:HYPERSNAP_EXPECTED_PEER_ID -Name 'HYPERSNAP_EXPECTED_PEER_ID'
    Test-SnapMeterVersionValue -Value $env:SNAPCHAIN_EXPECTED_VERSION -Name 'SNAPCHAIN_EXPECTED_VERSION'
    Test-SnapMeterVersionValue -Value $env:HYPERSNAP_EXPECTED_VERSION -Name 'HYPERSNAP_EXPECTED_VERSION'

    $fallbackUrlConfigured = -not [string]::IsNullOrWhiteSpace($env:HYPERSNAP_FALLBACK_HTTP_URL)
    $fallbackPeerConfigured = -not [string]::IsNullOrWhiteSpace($env:HYPERSNAP_FALLBACK_EXPECTED_PEER_ID)
    $fallbackVersionConfigured = -not [string]::IsNullOrWhiteSpace($env:HYPERSNAP_FALLBACK_EXPECTED_VERSION)
    if (-not $fallbackUrlConfigured -and ($fallbackPeerConfigured -or $fallbackVersionConfigured)) {
        throw 'Hypersnap fallback identity pins require HYPERSNAP_FALLBACK_HTTP_URL.'
    }
    if ($fallbackUrlConfigured) {
        [void](Get-SnapMeterHttpsUri -Value $env:HYPERSNAP_FALLBACK_HTTP_URL -Name 'HYPERSNAP_FALLBACK_HTTP_URL')
        if (-not $fallbackPeerConfigured -or -not $fallbackVersionConfigured) {
            throw 'A Hypersnap HTTPS fallback requires both HYPERSNAP_FALLBACK_EXPECTED_PEER_ID and HYPERSNAP_FALLBACK_EXPECTED_VERSION.'
        }
    }
    Test-SnapMeterPeerIdValue -Value $env:HYPERSNAP_FALLBACK_EXPECTED_PEER_ID -Name 'HYPERSNAP_FALLBACK_EXPECTED_PEER_ID'
    Test-SnapMeterVersionValue -Value $env:HYPERSNAP_FALLBACK_EXPECTED_VERSION -Name 'HYPERSNAP_FALLBACK_EXPECTED_VERSION'

    $snapchainMode = if ([string]::IsNullOrWhiteSpace($env:SNAPCHAIN_SOURCE_MODE)) { 'verified' } else { $env:SNAPCHAIN_SOURCE_MODE.ToLowerInvariant() }
    $hypersnapMode = if ([string]::IsNullOrWhiteSpace($env:HYPERSNAP_SOURCE_MODE)) { 'derived' } else { $env:HYPERSNAP_SOURCE_MODE.ToLowerInvariant() }
    if ($snapchainMode -notin @('verified', 'unavailable')) {
        throw 'SNAPCHAIN_SOURCE_MODE must be verified or unavailable; the canonical adapter is not a derived source.'
    }
    if ($hypersnapMode -notin @('derived', 'unavailable')) {
        throw 'HYPERSNAP_SOURCE_MODE cannot be verified with the currently pinned upstream source; use derived or unavailable.'
    }

    foreach ($name in @('SNAPMETER_INGEST_SECRET', 'SNAPCHAIN_GRPC_AUTHORIZATION', 'HYPERSNAP_GRPC_AUTHORIZATION', 'SNAPCHAIN_GRPC_API_KEY', 'HYPERSNAP_GRPC_API_KEY')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrEmpty($value) -and ($value.Length -gt 8192 -or $value -match '[\x00-\x1F\x7F]')) {
            throw "$name contains unsupported control characters or is too long."
        }
    }

    if ($RequireCloud) {
        if ([string]::IsNullOrWhiteSpace($env:SNAPMETER_INGEST_URL)) {
            throw 'SNAPMETER_INGEST_URL is required for continuous cloud delivery.'
        }
        [Uri]$ingestUri = $null
        if (-not [Uri]::TryCreate($env:SNAPMETER_INGEST_URL, [UriKind]::Absolute, [ref]$ingestUri) -or
            $ingestUri.Scheme -ne 'https' -or
            -not [string]::IsNullOrEmpty($ingestUri.UserInfo)) {
            throw 'SNAPMETER_INGEST_URL must be an absolute HTTPS URL without embedded credentials.'
        }
        if ([string]::IsNullOrWhiteSpace($env:SNAPMETER_INGEST_SECRET) -or $env:SNAPMETER_INGEST_SECRET.Length -lt 32) {
            throw 'SNAPMETER_INGEST_SECRET must contain at least 32 characters for continuous cloud delivery.'
        }
    }
}

function Get-SnapMeterDataDirectory {
    param([AllowEmptyString()][string]$Override)

    $configured = if (-not [string]::IsNullOrWhiteSpace($Override)) {
        $Override
    } elseif (-not [string]::IsNullOrWhiteSpace($env:SNAPMETER_DATA_DIR)) {
        $env:SNAPMETER_DATA_DIR
    } else {
        Join-Path ([Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)) 'SnapMeter'
    }
    return Resolve-SnapMeterPath -Path $configured
}

function Initialize-SnapMeterDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not [System.IO.Path]::IsPathRooted($fullPath)) {
        throw 'Directory path must resolve to an absolute path.'
    }
    [void](New-Item -ItemType Directory -Path $fullPath -Force)

    $probeName = '.snapmeter-write-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $probePath = Join-Path $fullPath $probeName
    try {
        $stream = [System.IO.File]::Open($probePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $stream.Dispose()
    } finally {
        if (Test-Path -LiteralPath $probePath -PathType Leaf) {
            Remove-Item -LiteralPath $probePath -Force
        }
    }
    return $fullPath
}

function Get-SnapMeterCommandPath {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) {
            return $command.Source
        }
    }
    throw "Required command was not found: $($Names -join ', ')"
}

function Protect-SnapMeterText {
    param([AllowNull()][object]$InputObject)

    $text = if ($null -eq $InputObject) { '' } else { [string]$InputObject }
    foreach ($entry in Get-ChildItem Env:) {
        if ($entry.Name -match '(?i)(api[_-]?key|secret|token|password|authorization|signature|cookie)' -and
            -not [string]::IsNullOrWhiteSpace($entry.Value)) {
            $text = $text.Replace([string]$entry.Value, '[REDACTED]')
        }
    }
    $text = [regex]::Replace(
        $text,
        '(?i)\b(api[_-]?key|authorization|secret|token|password|signature|cookie)\b\s*[:=]\s*([^\s,;]+)',
        '$1=[REDACTED]'
    )
    return $text
}

function Test-SnapMeterAdministrator {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        return $false
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Export-ModuleMember -Function @(
    'Get-SnapMeterRepositoryRoot',
    'Resolve-SnapMeterPath',
    'Import-SnapMeterEnvironment',
    'Get-SnapMeterEndpoint',
    'Get-SnapMeterHypersnapInfoUri',
    'Test-SnapMeterBooleanValue',
    'Test-SnapMeterIntegerValue',
    'Test-SnapMeterConfiguration',
    'Get-SnapMeterDataDirectory',
    'Initialize-SnapMeterDirectory',
    'Get-SnapMeterCommandPath',
    'Protect-SnapMeterText',
    'Test-SnapMeterAdministrator'
)

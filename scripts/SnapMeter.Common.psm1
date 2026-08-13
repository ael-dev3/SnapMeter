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

    $match = [regex]::Match($Value.Trim(), '^(?:\[(?<ipv6>[^\]]+)\]|(?<host>[^:/\s]+)):(?<port>[0-9]{1,5})$')
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

    $snapchainMode = if ([string]::IsNullOrWhiteSpace($env:SNAPCHAIN_SOURCE_MODE)) { 'verified' } else { $env:SNAPCHAIN_SOURCE_MODE.ToLowerInvariant() }
    $hypersnapMode = if ([string]::IsNullOrWhiteSpace($env:HYPERSNAP_SOURCE_MODE)) { 'derived' } else { $env:HYPERSNAP_SOURCE_MODE.ToLowerInvariant() }
    if ($snapchainMode -notin @('verified', 'unavailable')) {
        throw 'SNAPCHAIN_SOURCE_MODE must be verified or unavailable; the canonical adapter is not a derived source.'
    }
    if ($hypersnapMode -notin @('derived', 'unavailable')) {
        throw 'HYPERSNAP_SOURCE_MODE cannot be verified with the currently pinned upstream source; use derived or unavailable.'
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
        if ($entry.Name -match '(?i)(secret|token|password|authorization|signature|cookie)' -and
            -not [string]::IsNullOrWhiteSpace($entry.Value)) {
            $text = $text.Replace([string]$entry.Value, '[REDACTED]')
        }
    }
    $text = [regex]::Replace(
        $text,
        '(?i)\b(authorization|secret|token|password|signature|cookie)\b\s*[:=]\s*([^\s,;]+)',
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
    'Test-SnapMeterBooleanValue',
    'Test-SnapMeterIntegerValue',
    'Test-SnapMeterConfiguration',
    'Get-SnapMeterDataDirectory',
    'Initialize-SnapMeterDirectory',
    'Get-SnapMeterCommandPath',
    'Protect-SnapMeterText',
    'Test-SnapMeterAdministrator'
)

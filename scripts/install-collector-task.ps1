[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$EnvFile = '.env',
    [string]$TaskName = 'SnapMeterCollector',
    [string]$DataDirectory = '',
    [string]$LogDirectory = '',
    [switch]$AtBoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'SnapMeter.Common.psm1') -Force
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows Task Scheduler is only available on Windows.'
}
if ($TaskName -notmatch '^[A-Za-z0-9_. -]{1,100}$') {
    throw 'TaskName contains unsupported characters.'
}
if ($AtBoot -and -not (Test-SnapMeterAdministrator)) {
    throw 'The -AtBoot SYSTEM task requires an elevated PowerShell session.'
}

$repositoryRoot = Get-SnapMeterRepositoryRoot
$environment = Import-SnapMeterEnvironment -Path $EnvFile
Test-SnapMeterConfiguration -RequireCloud

$runScript = Resolve-SnapMeterPath -Path (Join-Path $PSScriptRoot 'run-collector.ps1') -MustExist
$nodePath = Get-SnapMeterCommandPath -Names @('node.exe', 'node')
$pnpmPath = Get-SnapMeterCommandPath -Names @('pnpm.cmd', 'pnpm')
$powerShellPath = Get-SnapMeterCommandPath -Names @('powershell.exe')
$nodeVersionText = (& $nodePath --version).TrimStart('v')
$nodeVersion = $null
if (-not [Version]::TryParse($nodeVersionText, [ref]$nodeVersion) -or $nodeVersion.Major -lt 24) {
    throw "Node.js 24 or later is required by the scheduled collector; found $nodeVersionText."
}
$pnpmVersionText = (& $pnpmPath --version).Trim()
$pnpmVersion = $null
if (-not [Version]::TryParse($pnpmVersionText, [ref]$pnpmVersion) -or $pnpmVersion.Major -lt 11) {
    throw "pnpm 11 or later is required by the scheduled collector; found $pnpmVersionText."
}
$resolvedData = Get-SnapMeterDataDirectory -Override $DataDirectory
$resolvedLog = if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
    Join-Path $resolvedData 'logs'
} else {
    Resolve-SnapMeterPath -Path $LogDirectory
}
[void](Initialize-SnapMeterDirectory -Path $resolvedData)
[void](Initialize-SnapMeterDirectory -Path $resolvedLog)

$quoted = @($runScript, $environment.Path, $resolvedData, $resolvedLog, $pnpmPath)
if ($quoted.Where({ $_.Contains('"') }).Count -gt 0) {
    throw 'Resolved task paths may not contain a double quote.'
}

$arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $runScript),
    '-Mode', 'run',
    '-EnvFile', ('"{0}"' -f $environment.Path),
    '-DataDirectory', ('"{0}"' -f $resolvedData),
    '-LogDirectory', ('"{0}"' -f $resolvedLog),
    '-PnpmPath', ('"{0}"' -f $pnpmPath)
) -join ' '

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $repositoryRoot
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650)

if ($AtBoot) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $runIdentity = 'SYSTEM at Windows startup'
} else {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
    $principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited
    $runIdentity = "$currentIdentity at logon"
}

$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'SnapMeter local collector. Restarts after failure; configuration values are loaded from a protected env file.'

if ($PSCmdlet.ShouldProcess($TaskName, "Register restartable collector task as $runIdentity")) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

Write-Host "Task '$TaskName' is configured for $runIdentity."
Write-Host "Data directory: $resolvedData"
Write-Host "Log directory: $resolvedLog"
Write-Host "Remove it with: .\scripts\uninstall-collector-task.ps1 -TaskName '$TaskName'"
if ($AtBoot -and $environment.Path.StartsWith([Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile), [StringComparison]::OrdinalIgnoreCase)) {
    Write-Warning 'The SYSTEM task references a file under a user profile. Confirm SYSTEM read access before relying on boot startup.'
}

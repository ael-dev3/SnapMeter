[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param([string]$TaskName = 'SnapMeterCollector')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($TaskName -notmatch '^[A-Za-z0-9_. -]{1,100}$') {
    throw 'TaskName contains unsupported characters.'
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host "Task '$TaskName' is not installed. No state was changed."
    return
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister scheduled task')) {
    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host "Task '$TaskName' was removed. Collector databases, logs, outbox data, and environment files were preserved."

#Requires -RunAsAdministrator

$TaskName = "SLB_DataScraper"
$ScriptPath = Resolve-Path ".\scraper.js"
$NodePath = (Get-Command node).Source
$WorkingDir = Split-Path -Parent $ScriptPath
$LogDir = "$WorkingDir\logs"

# Create log directory
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Action: Run Node.js with proper working directory
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$ScriptPath`"" -WorkingDirectory $WorkingDir

# Trigger: Every 30 minutes, starting now
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration ([TimeSpan]::MaxValue)

# Settings: Run whether user is logged on or not, with highest privileges, restart on failure
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest

$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# Register the task
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "Scrapes SLB dashboard every 30 minutes" -Force

Write-Host "Task '$TaskName' created successfully!" -ForegroundColor Green
Write-Host "Logs will be written to: $LogDir" -ForegroundColor Cyan
Write-Host "`nTo view logs:" -ForegroundColor Yellow
Write-Host "  Get-Content '$LogDir\stdout.log' -Wait" -ForegroundColor Gray
Write-Host "`nTo run manually:" -ForegroundColor Yellow
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Gray
Write-Host "`nTo disable:" -ForegroundColor Yellow
Write-Host "  Disable-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Gray
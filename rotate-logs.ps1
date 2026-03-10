$DataDir = ".\data"
$ScreenshotDir = ".\screenshots"
$MaxAgeDays = 7

# Remove old data files
Get-ChildItem -Path $DataDir -Filter "data_*.json" | 
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$MaxAgeDays) } |
    Remove-Item -Force

# Remove old screenshots
Get-ChildItem -Path $ScreenshotDir -Filter "*.png" | 
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$MaxAgeDays) } |
    Remove-Item -Force

Write-Host "Cleaned up files older than $MaxAgeDays days"
$ErrorActionPreference = 'SilentlyContinue'

$patterns = @(
  'SetmorePlaywrightProfile',
  'connect_and_upload',
  'run:persistent',
  'launch-setmore'
)

$regex = ($patterns | ForEach-Object { [regex]::Escape($_) }) -join '|'

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $regex } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep -Seconds 2

$projectDir = Join-Path $env:USERPROFILE 'Desktop\setmore-playwright'
$command = 'cd /d "{0}" && set USE_PERSISTENT_CONTEXT=1&& set AUTO_START=1&& node connect_and_upload.js' -f $projectDir

Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $command) -WorkingDirectory $projectDir
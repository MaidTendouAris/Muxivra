param([string]$Installer = '', [ValidateSet('desktop','player','parameters','ui','mcp-setup','tasks')][string[]]$Suites = @('desktop','player','parameters','ui','mcp-setup','tasks'))
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Installer) {
  $packageMetadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $Installer = Join-Path $projectRoot "release\Muxivra-$($packageMetadata.version)-win-x64-setup.exe"
}
$testRoot = Join-Path $projectRoot '.test-data'
$registryPaths = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
function Get-MuxivraInstallation {
  Get-ItemProperty $registryPaths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Muxivra*' }
}
function Assert-TestPath([string]$Candidate) {
  $resolved = [IO.Path]::GetFullPath($Candidate)
  if (-not $resolved.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '安装验证路径必须位于项目 .test-data 内' }
  return $resolved
}
if (Get-MuxivraInstallation) { throw '检测到已有 Muxivra 安装，停止临时安装验证，避免影响现有安装' }
if (Get-Process -Name Muxivra -ErrorAction SilentlyContinue) { throw '检测到正在运行的 Muxivra，停止临时安装验证；可以设置 MUXIVRA_EXECUTABLE 验证独立打包副本' }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installationRoot = Assert-TestPath (Join-Path $testRoot ('install-' + [Guid]::NewGuid().ToString()))
$target = Assert-TestPath (Join-Path $installationRoot 'Muxivra')
$previousExecutable = $env:MUXIVRA_EXECUTABLE
New-Item -ItemType Directory -Path $installationRoot -Force | Out-Null
Push-Location $projectRoot
try {
  $installProcess = Start-Process -FilePath $installerPath -ArgumentList @('/S',"/D=$target") -WindowStyle Hidden -Wait -PassThru
  if ($installProcess.ExitCode -ne 0) { throw "安装失败：$($installProcess.ExitCode)" }
  $installedExecutable = Join-Path $target 'Muxivra.exe'
  if (-not (Test-Path -LiteralPath $installedExecutable)) { throw '安装目录内没有生成 Muxivra.exe' }
  $processingEngines = Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object { $_.Name -in @('ffmpeg.exe','ffprobe.exe') }
  if ($processingEngines) { throw '安装包意外包含 FFmpeg/ffprobe 处理引擎' }
  $env:MUXIVRA_EXECUTABLE = $installedExecutable
  $checks = @(
    @{ Name='desktop'; Script='desktop-smoke'; Report='installed-smoke'; Description='桌面' },
    @{ Name='player'; Script='player-smoke'; Report='installed-player-smoke'; Description='mpv 播放器' },
    @{ Name='parameters'; Script='parameters-smoke'; Report='installed-parameters-smoke'; Description='参数与预设' },
    @{ Name='ui'; Script='ui-smoke'; Report='installed-ui-smoke'; Description='界面与退出流程' },
    @{ Name='mcp-setup'; Script='mcp-setup-smoke'; Report='installed-mcp-setup-smoke'; Description='MCP 接入与内置指南' },
    @{ Name='tasks'; Script='task-history-smoke'; Report='installed-task-history-smoke'; Description='任务历史、分页与删除' }
  )
  foreach ($check in $checks) {
    if ($check.Name -notin $Suites) { continue }
    & node (Join-Path $projectRoot "scripts\$($check.Script).mjs")
    if ($LASTEXITCODE -ne 0) { throw "已安装应用 $($check.Description) 验证失败" }
    Copy-Item -LiteralPath (Join-Path $projectRoot "artifacts\qa\$($check.Script).json") -Destination (Join-Path $projectRoot "artifacts\qa\$($check.Report).json")
  }
} finally {
  $env:MUXIVRA_EXECUTABLE = $previousExecutable
  $uninstaller = Join-Path $target 'Uninstall Muxivra.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $null = Assert-TestPath $target
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($uninstallProcess.ExitCode -ne 0) { throw "卸载失败：$($uninstallProcess.ExitCode)" }
    for ($attempt = 0; $attempt -lt 20 -and (Test-Path -LiteralPath (Join-Path $target 'Muxivra.exe')); $attempt++) { Start-Sleep -Milliseconds 500 }
    if (Test-Path -LiteralPath (Join-Path $target 'Muxivra.exe')) { throw '卸载后主程序仍然存在，请检查临时安装目录' }
  }
  Pop-Location
  $null = Assert-TestPath $installationRoot
  Remove-Item -LiteralPath $installationRoot -Recurse -Force
}
if (Get-MuxivraInstallation) { throw '卸载后安装登记仍然存在' }
Write-Output '已安装应用验证通过；临时安装已卸载。'

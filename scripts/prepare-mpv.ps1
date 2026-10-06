param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'resources\mpv-manifest.json') -Raw | ConvertFrom-Json
$playerDirectory = Join-Path $projectRoot 'resources\mpv'
$playerExecutable = Join-Path $playerDirectory 'mpv.exe'
if (Test-Path -LiteralPath $playerExecutable) {
    if ((Get-Sha256 $playerExecutable) -eq $manifest.executableSha256) {
        Write-Output "mpv $($manifest.version): SHA-256 verified"
        exit 0
    }
    throw 'resources/mpv/mpv.exe 校验失败；请移除不匹配的文件后重新准备，不使用未知二进制'
}
if ($VerifyOnly) { throw '缺少内置 mpv；先运行 npm run prepare:mpv' }
$cacheDirectory = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
$archivePath = Join-Path $cacheDirectory "mpv-$($manifest.release).7z"
if (-not (Test-Path -LiteralPath $archivePath)) {
    Invoke-WebRequest -Uri $manifest.url -OutFile $archivePath -UseBasicParsing
}
if ((Get-Sha256 $archivePath) -ne $manifest.archiveSha256) { throw 'mpv 下载包 SHA-256 校验失败' }
$extractor = Join-Path $projectRoot 'node_modules\electron-winstaller\vendor\7z.exe'
if (-not (Test-Path -LiteralPath $extractor)) { throw '请先安装锁定的 npm 依赖，以获取构建用 7-Zip' }
New-Item -ItemType Directory -Path $playerDirectory -Force | Out-Null
& $extractor e $archivePath "-o$playerDirectory" 'mpv.exe' -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'mpv 解压失败' }
if ((Get-Sha256 $playerExecutable) -ne $manifest.executableSha256) { throw 'mpv 可执行文件 SHA-256 校验失败' }
Write-Output "mpv $($manifest.version): prepared and SHA-256 verified"

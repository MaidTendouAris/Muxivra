$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Use the exact same official, checksummed build as the application downloader.
$source = Get-Content -LiteralPath (Join-Path $projectRoot 'src/core/engine/index.ts') -Raw
$url = [regex]::Match($source, "url:\s*'(https://www\.gyan\.dev/[^']+\.zip)'").Groups[1].Value
$sha256 = [regex]::Match($source, "sha256:\s*'([a-f0-9]{64})'").Groups[1].Value
if (-not $url -or -not $sha256) { throw 'Cannot read the pinned FFmpeg download manifest.' }
$directory = Join-Path $projectRoot '.runtime/ci-ffmpeg'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$archive = Join-Path $directory 'ffmpeg.zip'
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $url -OutFile $archive -MaximumRetryCount 3 }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) { throw 'FFmpeg SHA-256 mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
$executable = @(Get-ChildItem -LiteralPath $directory -Recurse -File -Filter ffmpeg.exe)
if ($executable.Count -ne 1) { throw 'Expected exactly one FFmpeg executable.' }
$bin = $executable[0].DirectoryName
if (-not (Test-Path -LiteralPath (Join-Path $bin 'ffprobe.exe'))) { throw 'Missing ffprobe.' }
if ($env:GITHUB_PATH) { $bin | Out-File -LiteralPath $env:GITHUB_PATH -Encoding utf8 -Append }
& $executable[0].FullName -version
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg verification failed.' }

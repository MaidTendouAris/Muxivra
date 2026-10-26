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
$extractor = Join-Path $projectRoot 'node_modules\electron-winstaller\vendor\7z.exe'
$cacheDirectory = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $playerDirectory -Force | Out-Null
# The CLI is prepared for headless integration tests only. The application and
# distributable use libmpv, never a separate native-window mpv process.
$artifacts = @(
    @{ Name = 'libmpv-2.dll'; Url = $manifest.libraryUrl; ArchiveHash = $manifest.libraryArchiveSha256; Hash = $manifest.librarySha256; Cache = "libmpv-$($manifest.release).7z" },
    @{ Name = 'mpv.exe'; Url = $manifest.url; ArchiveHash = $manifest.archiveSha256; Hash = $manifest.executableSha256; Cache = "mpv-$($manifest.release).7z" }
)
foreach ($artifact in $artifacts) {
    $target = Join-Path $playerDirectory $artifact.Name
    if ((Test-Path -LiteralPath $target) -and ((Get-Sha256 $target) -eq $artifact.Hash)) {
        Write-Output "$($artifact.Name) $($manifest.version): SHA-256 verified"
        continue
    }
    if ($VerifyOnly) { throw "$($artifact.Name) missing or checksum mismatch; run npm run prepare:mpv" }
    if (-not (Test-Path -LiteralPath $extractor)) { throw 'Install locked npm dependencies to obtain the build-time 7-Zip extractor.' }
    $archivePath = Join-Path $cacheDirectory $artifact.Cache
    if (-not (Test-Path -LiteralPath $archivePath)) { Invoke-WebRequest -Uri $artifact.Url -OutFile $archivePath -UseBasicParsing }
    if ((Get-Sha256 $archivePath) -ne $artifact.ArchiveHash) { throw "$($artifact.Name) archive SHA-256 mismatch" }
    $staging = Join-Path $cacheDirectory ("mpv-stage-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    try {
        & $extractor e $archivePath "-o$staging" $artifact.Name -y | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'mpv extraction failed' }
        $verified = Join-Path $staging $artifact.Name
        if ((Get-Sha256 $verified) -ne $artifact.Hash) { throw "$($artifact.Name) SHA-256 mismatch" }
        Copy-Item -LiteralPath $verified -Destination $target -Force
    } finally {
        # This path is freshly created under the verified workspace cache.
        $resolvedStaging = [IO.Path]::GetFullPath($staging)
        if (-not $resolvedStaging.StartsWith([IO.Path]::GetFullPath($cacheDirectory) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected staging path' }
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
    Write-Output "$($artifact.Name) $($manifest.version): prepared and SHA-256 verified"
}

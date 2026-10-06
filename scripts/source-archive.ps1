param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\release'))
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$archiveOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $archiveOutput.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '源码归档输出必须位于项目内' }
New-Item -ItemType Directory -Path $archiveOutput -Force | Out-Null
$packageMetadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$archivePath = Join-Path $archiveOutput "Muxivra-$($packageMetadata.version)-source.zip"
$includedNames = @('src','tests','scripts','resources','docs','README.md','README.zh-CN.md','LICENSE','THIRD-PARTY-NOTICES.txt','package.json','package-lock.json','tsconfig.json','electron.vite.config.ts','electron-builder.yml','vitest.config.ts','vitest.integration.config.ts','components.json','.gitignore','.npmrc')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($archivePath,[IO.FileMode]::Create)
$archive = New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($name in $includedNames) {
        $candidate = Get-Item -LiteralPath (Join-Path $projectRoot $name) -Force
        $files = if ($candidate.PSIsContainer) { Get-ChildItem -LiteralPath $candidate.FullName -Recurse -File -Force } else { @($candidate) }
        foreach ($file in $files) {
            $relativePath = $file.FullName.Substring($projectRoot.Length + 1).Replace('\','/')
            if ($relativePath.StartsWith('resources/mpv/')) { continue }
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$relativePath,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
} finally { $archive.Dispose(); $stream.Dispose() }
Get-Item -LiteralPath $archivePath | Select-Object FullName,Length

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $package.version
$appDir = Join-Path $root 'dist\RobloxCodesGET-win32-x64'
$releaseDir = Join-Path $root 'release'
$exePath = Join-Path $appDir 'RobloxCodesGET.exe'

if (-not (Test-Path $exePath)) {
    throw "Packaged app not found: $exePath. Run 'npm run pack' first."
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

Copy-Item (Join-Path $root 'packaging\README.txt') (Join-Path $appDir 'README-FIRST.txt') -Force
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $appDir 'LICENSE.txt') -Force

$appZip = Join-Path $releaseDir "RobloxCodesGET-v$version-win64.zip"
$sourceZip = Join-Path $releaseDir "RobloxCodesGET-v$version-source.zip"
foreach ($file in @($appZip, $sourceZip)) {
    if (Test-Path $file) { Remove-Item $file -Force }
}

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path $tar) {
    Write-Host "Compressing app to $appZip ..."
    & $tar -a -c -f $appZip -C $appDir .

    Write-Host "Compressing source to $sourceZip ..."
    & $tar -a -c -f $sourceZip --exclude=node_modules --exclude=dist --exclude=release --exclude=.tmp --exclude=.git --exclude=*.log -C $root .
} else {
    Write-Host "Compressing app to $appZip ..."
    Compress-Archive -Path (Join-Path $appDir '*') -DestinationPath $appZip -CompressionLevel Fastest

    $sourceDir = Join-Path $root ".tmp\RobloxCodesGET-v$version-source"
    if (Test-Path $sourceDir) { Remove-Item $sourceDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
    $exclude = @('node_modules', 'dist', 'release', '.tmp', '.git')
    Get-ChildItem $root -Force |
        Where-Object { $exclude -notcontains $_.Name } |
        ForEach-Object { Copy-Item $_.FullName -Destination $sourceDir -Recurse -Force }
    Compress-Archive -Path $sourceDir -DestinationPath $sourceZip -CompressionLevel Fastest
}

$hashLines = @()
foreach ($file in @($appZip, $sourceZip)) {
    $hash = Get-FileHash $file -Algorithm SHA256
    $hashLines += "$($hash.Hash)  $(Split-Path $hash.Path -Leaf)"
}
Set-Content -Path (Join-Path $releaseDir 'SHA256.txt') -Value $hashLines -Encoding UTF8

Write-Host ''
Write-Host 'Build artifacts:'
Get-Item $appZip, $sourceZip | ForEach-Object {
    Write-Host ("  {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB))
}
Write-Host ("  {0}" -f (Join-Path $releaseDir 'SHA256.txt'))

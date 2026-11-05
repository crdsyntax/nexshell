param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = '',
  [string]$PrivateKey = '',
  [string]$PasswordFile = '',
  [string]$BaseUrl = 'https://nexshell-updates.crdsyntax.workers.dev',
  [string]$OutDir = 'update-dist'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'node_modules/@tauri-apps/cli/tauri.js'

if (-not (Test-Path $cli)) { throw "Tauri CLI not found: $cli" }
if ($Notes -eq '') { throw 'Provide -Notes with the changelog for the manifest.' }

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @Arguments 2>&1
    }
    finally {
        $ErrorActionPreference = $prev
    }
    $output
}

Write-Host "Building bundles for version $Version ..."
$buildOut = Invoke-Native node @($cli, 'build')
$buildOut | ForEach-Object { Write-Host $_.ToString() }
if ($LASTEXITCODE -ne 0) { throw "Build failed (exit $LASTEXITCODE): $($buildOut | Out-String)" }

$bundleRoot = Join-Path $root 'src-tauri/target/release/bundle'
$artifacts = @{}

$msi = Get-ChildItem (Join-Path $bundleRoot 'msi') -Filter "*.msi" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*$Version*" }
$deb = Get-ChildItem (Join-Path $bundleRoot 'deb') -Filter "*.deb" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*$Version*" }
$appimage = Get-ChildItem (Join-Path $bundleRoot 'appimage') -Filter "*.AppImage" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*$Version*" }

if ($msi) { $artifacts['windows-x86_64'] = $msi[0] }
if ($deb) { $artifacts['linux-x86_64'] = $deb[0] }
if ($appimage) { $artifacts['linux-x86_64-appimage'] = $appimage[0] }

if ($artifacts.Count -eq 0) { throw "No bundles found for version $Version under $bundleRoot" }

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$platforms = @{}
foreach ($platform in $artifacts.Keys) {
  $file = $artifacts[$platform]
  $signature = ""

  if ($PrivateKey -ne '' -and (Test-Path $PrivateKey)) {
    Write-Host "Signing $($file.Name) for $platform ..."
    $passwordArgs = @()
    if ($PasswordFile -ne '' -and (Test-Path $PasswordFile)) {
      $password = (Get-Content $PasswordFile -Raw).Trim()
      $passwordArgs = @('-p', $password)
    }
    $sigOut = Invoke-Native node @($cli, 'signer', 'sign', '-f', $PrivateKey) + $passwordArgs + @($file.FullName)
    if ($LASTEXITCODE -ne 0) { throw "Signing failed for $($file.Name): $($sigOut | Out-String)" }
    $signature = ($sigOut | ForEach-Object { $_.ToString() } | Where-Object { $_.Trim() -ne '' } | Select-String -Pattern '^dW50cnVzdGVk' | Select-Object -First 1)
    if ($signature) { $signature = $signature.ToString().Trim() }
  } else {
    $sigFile = "$($file.FullName).sig"
    if (Test-Path $sigFile) {
      $signature = (Get-Content $sigFile -Raw).Trim()
    }
  }

  $dest = Join-Path $OutDir $file.Name
  Copy-Item $file.FullName $dest -Force
  $platforms[$platform] = @{
    url = "$BaseUrl/$($file.Name)"
    signature = $signature
  }
}

$manifest = @{
  version = $Version
  notes   = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = $platforms
} | ConvertTo-Json -Depth 4

$manifestPath = Join-Path $OutDir 'latest.json'
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Done. Upload the contents of '$OutDir' to $BaseUrl:"
Write-Host "node ../nexshell-updates/scripts/upload.mjs --dir ./update-dist --url $BaseUrl --token <ADMIN_TOKEN>"

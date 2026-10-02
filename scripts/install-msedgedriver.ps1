# Install msedgedriver in EXACTE version of runtime WebView2 .
#
#   pwsh scripts/install-msedgedriver.ps1 [-Destination <folder>]
#
# The version is read in the registry (HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-...}, value `pv`),
# then msedgedriver is downloaded from msedgedriver.microsoft.com. The folder is added to the job's PATH
# (GITHUB_PATH): tauri-driver finds msedgedriver.exe. If Microsoft did not release this exact version, the
# driver of the same major number is used with a warning (the major must match); otherwise failure.
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path ($env:RUNNER_TEMP ?? $env:TEMP) 'msedgedriver')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$clientKey = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
if (-not (Test-Path $clientKey)) {
    throw "Runtime WebView2 not found (logger key missing: $clientKey)"
}
$version = (Get-ItemProperty -Path $clientKey -Name pv).pv
if (-not $version) { throw "Valeur 'pv' vide sous $clientKey" }
Write-Host "Runtime WebView2 : $version"

$base = 'https://msedgedriver.microsoft.com'
$zip = Join-Path ($env:RUNNER_TEMP ?? $env:TEMP) 'edgedriver_win64.zip'

function Get-Driver([string]$ver) {
    try {
        Invoke-WebRequest -Uri "$base/$ver/edgedriver_win64.zip" -OutFile $zip -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

$driverVersion = $version
if (-not (Get-Driver $version)) {
    $major = $version.Split('.')[0]
    # Text file UTF-16 (BOM): decoded by hand if it arrives in bytes, then cleans control characters.
    $latest = (Invoke-WebRequest -Uri "$base/LATEST_RELEASE_${major}_WINDOWS" -UseBasicParsing).Content
    if ($latest -is [byte[]]) { $latest = [System.Text.Encoding]::Unicode.GetString($latest) }
    $driverVersion = ([string]$latest -replace '[^0-9.]', '').Trim()
    if (-not $driverVersion -or -not (Get-Driver $driverVersion)) {
        throw "No msedgedriver published for the runtime $version (major $major)"
    }
    Write-Warning "msedgedriver $unpublished version: using $driverVersion (even major)"
}

if (Test-Path $Destination) { Remove-Item -Recurse -Force $Destination }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Expand-Archive -Path $zip -DestinationPath $Destination -Force
Remove-Item $zip

$exe = Join-Path $Destination 'msedgedriver.exe'
if (-not (Test-Path $exe)) { throw "msedgedriver.exe absent de l'archive ($Destination)" }
$reported = (& $exe --version) -join ' '
Write-Host "msedgedriver installed : $reported"
if ($reported -notmatch [regex]::Escape($driverVersion)) {
    throw "Version inattendue : '$reported' (attendue $driverVersion)"
}

if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $Destination }
$env:PATH = "$Destination;$env:PATH"
if ($env:GITHUB_ENV) { Add-Content -Path $env:GITHUB_ENV -Value "GITMINI_MSEDGEDRIVER_VERSION=$driverVersion" }

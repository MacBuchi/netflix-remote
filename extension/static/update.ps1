# Couch Remote: updates this folder to the latest release on GitHub (started by update.cmd).
# Chrome notices the new files on its own and reloads the extension.
$ErrorActionPreference = 'Stop'
$repo = 'MacBuchi/netflix-remote'
$dir = $PSScriptRoot

function Fail($message) {
    Write-Host ''
    Write-Host "Update fehlgeschlagen: $message"
    if (-not $env:CI) { Read-Host 'Enter zum Schliessen' }
    exit 1
}

$manifestPath = Join-Path $dir 'manifest.json'
if (-not (Test-Path $manifestPath)) { Fail 'Dieses Skript gehoert in den Ordner der Extension (neben manifest.json).' }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne 'Couch Remote') { Fail 'Dieses Skript gehoert in den Ordner der Extension (neben manifest.json).' }
$installed = $manifest.version

Write-Host "Couch Remote - installiert: $installed"
Write-Host 'Suche die neueste Version auf GitHub ...'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# github.com/.../releases/latest redirects to .../tag/v<version>; unlike the API it has no hourly limit.
try {
    $request = [Net.WebRequest]::Create("https://github.com/$repo/releases/latest")
    $request.AllowAutoRedirect = $false
    $response = $request.GetResponse()
    $location = $response.Headers['Location']
    $response.Close()
} catch { Fail 'GitHub nicht erreichbar.' }
if ($location -notmatch '/releases/tag/v?([0-9][0-9.]*)$') { Fail 'Keine Version zum Herunterladen gefunden.' }
$latest = $Matches[1]
$zip = "https://github.com/$repo/releases/download/v$latest/couch-remote-v$latest.zip"

if ($latest -eq $installed) {
    Write-Host 'Schon aktuell.'
} else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("couch-remote-" + [Guid]::NewGuid())
    New-Item -ItemType Directory $tmp | Out-Null
    try {
        Write-Host "Lade Version $latest ..."
        Invoke-WebRequest -UseBasicParsing $zip -OutFile (Join-Path $tmp 'update.zip')
        Expand-Archive (Join-Path $tmp 'update.zip') (Join-Path $tmp 'new')
        $new = Join-Path $tmp 'new'
        $newManifest = Get-Content (Join-Path $new 'manifest.json') -Raw | ConvertFrom-Json
        if ($newManifest.name -ne 'Couch Remote') { Fail 'Das ZIP enthaelt keine Couch-Remote-Extension.' }
        # Everything else first, the manifest last: its new version is what makes Chrome reload.
        Get-ChildItem $new -Recurse -File | Where-Object { $_.FullName -ne (Join-Path $new 'manifest.json') } | ForEach-Object {
            $target = Join-Path $dir $_.FullName.Substring($new.Length + 1)
            New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
            Copy-Item $_.FullName $target -Force
        }
        Copy-Item (Join-Path $new 'manifest.json') $manifestPath -Force
        Write-Host "Fertig: Version $latest. Chrome laedt Couch Remote innerhalb einer Minute neu (sofort beim Oeffnen des Popups)."
    } catch {
        Fail $_.Exception.Message
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}
if (-not $env:CI) { Start-Sleep -Seconds 5 }

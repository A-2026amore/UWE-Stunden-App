# Signs a release package on Arif's PC and hands it to the test server (Windows PowerShell, OpenSSH is built in).
# The private key never leaves the PC. Only packages signed with it are accepted by the server.
#
#   powershell -ExecutionPolicy Bypass -File paket-hochladen.ps1 -Paket C:\Users\User\appzentrale24\pakete\stundenwerk-<commit12>.bundle
#
# Steps: compare the checksum (the value is also given in the chat), sign (asks for the key passphrase),
# copy to /var/lib/stunden-test/eingang/ with scp, then on the server: stunden-test-paket <file> --freigeben.
# One-time key: ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\stundenwerk_paket" -C stundenwerk-paket
param(
  [Parameter(Mandatory = $true)][string]$Paket,
  [string]$Server = "root@159.195.199.222",
  [string]$Schluessel = "$env:USERPROFILE\.ssh\stundenwerk_paket",
  [switch]$NurSignieren
)
$ErrorActionPreference = "Stop"

$name = Split-Path $Paket -Leaf
if ($name -notmatch '^stundenwerk-[0-9a-f]{12}\.bundle$') { throw "Unerwarteter Dateiname: $name" }
if (-not (Test-Path $Schluessel)) { throw "Schlüssel $Schluessel fehlt (einmalig anlegen, siehe Kopf dieser Datei)." }

$ist = (Get-FileHash -Algorithm SHA256 $Paket).Hash.ToLower()
if (Test-Path "$Paket.sha256") {
  $soll = ((Get-Content "$Paket.sha256" -TotalCount 1) -split '\s+')[0].ToLower()
  if ($soll -ne $ist) { throw "Prüfsumme stimmt NICHT mit $name.sha256 überein – Paket nicht verwenden." }
}
Write-Host "Paket:   $name"
Write-Host "SHA-256: $ist"
Read-Host "Stimmt der Wert mit dem im Chat überein? Enter = weiter, Strg+C = Abbruch" | Out-Null

if (Test-Path "$Paket.sig") { Remove-Item "$Paket.sig" }
& ssh-keygen -Y sign -f $Schluessel -n stundenwerk-paket $Paket
if ($LASTEXITCODE -ne 0) { throw "Signieren fehlgeschlagen (OpenSSH mindestens 8.1 nötig: ssh -V)." }
if ($NurSignieren) { Write-Host "Signiert: $Paket.sig"; exit 0 }

& scp $Paket "$Paket.sig" "$Paket.sha256" "${Server}:/var/lib/stunden-test/eingang/"
if ($LASTEXITCODE -ne 0) { throw "Hochladen fehlgeschlagen." }
& ssh $Server "stunden-test-paket /var/lib/stunden-test/eingang/$name --freigeben"
if ($LASTEXITCODE -ne 0) { throw "Server hat das Paket NICHT angenommen (Meldung oben)." }
Write-Host "Fertig. Stand ansehen: ssh $Server stunden-test-freigeben --status"

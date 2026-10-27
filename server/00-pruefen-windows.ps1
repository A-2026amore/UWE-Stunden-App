# AppZentrale24 - Prüfung von Windows aus (nur lesend, ändert nichts)
#
# Ausführen in PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\00-pruefen-windows.ps1
#
# Prüft:
#   1. Welche DNS-Einträge appzentrale24.de heute hat (inkl. E-Mail-Einträge)
#   2. Ob die Domain und die geplanten Subdomains schon auf den Server zeigen
#   3. Ob die SSH-Anmeldung als appadmin mit dem Schlüssel funktioniert
# Eine Passphrase für den Schlüssel geben Sie nur lokal im Fenster ein, nie im Chat.

$Domain    = "appzentrale24.de"
$ServerIP  = "159.195.199.222"
$KeyFile   = "$env:USERPROFILE\.ssh\appzentrale24_ed25519"
$Subdomains = @("www", "begivo", "stunden", "telefon", "status")
$MailNames  = @("mail", "smtp", "imap", "pop3", "webmail", "autodiscover", "autoconfig", "_dmarc", "default._domainkey", "key1._domainkey")

$Report = Join-Path $PSScriptRoot "dns-bericht.txt"
"AppZentrale24 DNS-/SSH-Prüfung $(Get-Date -Format s)" | Out-File $Report -Encoding utf8

function Write-Both($text) { Write-Host $text; $text | Out-File $Report -Append -Encoding utf8 }

function Show-Records($name, $types) {
    foreach ($t in $types) {
        try {
            $r = Resolve-DnsName -Name $name -Type $t -Server 1.1.1.1 -DnsOnly -ErrorAction Stop |
                 Where-Object { $_.Section -eq "Answer" }
            foreach ($x in $r) {
                $val = switch ($x.Type) {
                    "A"     { $x.IPAddress }
                    "AAAA"  { $x.IPAddress }
                    "MX"    { "$($x.Preference) $($x.NameExchange)" }
                    "TXT"   { ($x.Strings -join "") }
                    "NS"    { $x.NameHost }
                    "CNAME" { $x.NameHost }
                    "CAA"   { "$($x.Flags) $($x.Tag) $($x.Value)" }
                    default { $x | Out-String }
                }
                Write-Both ("  {0,-28} {1,-6} {2}" -f $name, $x.Type, $val)
            }
        } catch { }
    }
}

Write-Both "`n=== 1. Nameserver und Hauptdomain ==="
Show-Records $Domain @("NS", "SOA", "A", "AAAA", "MX", "TXT", "CAA")

Write-Both "`n=== 2. E-Mail-relevante Einträge (dürfen NICHT verändert werden) ==="
foreach ($n in $MailNames) { Show-Records "$n.$Domain" @("A", "CNAME", "MX", "TXT") }

Write-Both "`n=== 3. Geplante Subdomains ==="
foreach ($s in $Subdomains) { Show-Records "$s.$Domain" @("A", "AAAA", "CNAME") }

Write-Both "`n=== 4. Zeigt die Domain auf den Server $ServerIP ? ==="
foreach ($n in @($Domain) + ($Subdomains | ForEach-Object { "$_.$Domain" })) {
    $ips = @()
    try { $ips = (Resolve-DnsName $n -Type A -Server 1.1.1.1 -DnsOnly -ErrorAction Stop | Where-Object { $_.Type -eq "A" }).IPAddress } catch { }
    if ($ips -contains $ServerIP) { Write-Both "  OK      $n -> $($ips -join ', ')" }
    elseif ($ips)                 { Write-Both "  ANDERS  $n -> $($ips -join ', ')  (zeigt NICHT auf den Server)" }
    else                          { Write-Both "  FEHLT   $n  (kein A-Eintrag)" }
}

Write-Both "`n=== 5. SSH-Anmeldung als appadmin ==="
if (-not (Test-Path $KeyFile)) {
    Write-Both "  Schlüsseldatei nicht gefunden: $KeyFile"
} else {
    Write-Host "  Falls nach einer Passphrase gefragt wird: hier lokal eingeben."
    $out = ssh -i $KeyFile -o IdentitiesOnly=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new `
        appadmin@$ServerIP "echo SSH_OK; hostname; whoami; . /etc/os-release; echo \$PRETTY_NAME; groups; sudo -n true 2>/dev/null && echo SUDO_OHNE_PASSWORT || echo SUDO_MIT_PASSWORT" 2>&1
    $out | ForEach-Object { Write-Both "  $_" }
    if ($out -match "SSH_OK") { Write-Both "  ERGEBNIS: SSH als appadmin funktioniert." }
    else { Write-Both "  ERGEBNIS: SSH-Anmeldung fehlgeschlagen (siehe Meldung oben)." }
}

Write-Both "`nBericht gespeichert: $Report"
Write-Host "Bitte den Inhalt von dns-bericht.txt in den Chat kopieren (enthält keine Geheimnisse)."

#!/usr/bin/env bash
# AppZentrale24 - Grundschutz für Debian 13 (netcup RS 2000)
#
# Richtet ein: Systemupdates, automatische Sicherheitsupdates, Zeitzone, Firewall (ufw),
# fail2ban und SSH-Härtung (nur noch Schlüssel, kein root-Login).
#
# Aufruf als appadmin:  sudo bash 02-grundschutz.sh
#
# WICHTIG: Die aktuelle SSH-Sitzung offen lassen, bis in einem ZWEITEN Fenster die
# Anmeldung als appadmin erfolgreich getestet wurde. Notfallzugang: VNC-Konsole im
# netcup Server Control Panel (SCP).
set -euo pipefail

ADMIN_USER="appadmin"
SSH_PORT="22"

die() { echo "ABBRUCH: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Bitte mit sudo ausführen."
[ "${SUDO_USER:-}" = "$ADMIN_USER" ] || die "Bitte als $ADMIN_USER anmelden und mit sudo ausführen (nicht direkt als root)."
. /etc/os-release
[ "$ID" = "debian" ] || die "Nur für Debian gedacht (gefunden: $ID)."

ADMIN_HOME=$(getent passwd "$ADMIN_USER" | cut -d: -f6)
[ -s "$ADMIN_HOME/.ssh/authorized_keys" ] || die "$ADMIN_USER hat keinen SSH-Schlüssel. SSH-Härtung würde aussperren."
id -nG "$ADMIN_USER" | grep -qw sudo || die "$ADMIN_USER ist nicht in der sudo-Gruppe."
# sudo muss für appadmin mit Passwort ODER ohne funktionieren - ohne Passwort-Login sonst kein Root mehr.
if ! sudo -u "$ADMIN_USER" sudo -n true 2>/dev/null; then
  passwd -S "$ADMIN_USER" | awk '{print $2}' | grep -q '^P$' \
    || die "$ADMIN_USER hat kein Passwort für sudo. Erst 'sudo passwd $ADMIN_USER' ausführen."
fi

cat <<EOF
Folgendes wird jetzt eingerichtet:
  - alle ausstehenden Debian-Updates installieren
  - automatische Sicherheitsupdates (Neustart bei Bedarf um 04:30 Uhr)
  - Zeitzone Europe/Berlin, Zeitsynchronisierung
  - Firewall: nur SSH ($SSH_PORT), HTTP (80) und HTTPS (443) von außen erreichbar
  - fail2ban gegen Passwort-Raten auf SSH
  - SSH: Anmeldung nur mit Schlüssel, root-Login gesperrt, nur Benutzer $ADMIN_USER
EOF
read -r -p "Fortfahren? Bitte JA eingeben: " answer
[ "$answer" = "JA" ] || die "Nicht bestätigt."

echo ">> Updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y full-upgrade
apt-get -y install unattended-upgrades apt-listchanges ufw fail2ban python3-systemd \
  ca-certificates curl gnupg git htop restic jq

echo ">> Automatische Sicherheitsupdates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat >/etc/apt/apt.conf.d/52appzentrale24-unattended <<'EOF'
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
systemctl enable --now unattended-upgrades

echo ">> Zeitzone"
timedatectl set-timezone Europe/Berlin
timedatectl set-ntp true || true

echo ">> Firewall"
ufw default deny incoming
ufw default allow outgoing
ufw limit "$SSH_PORT/tcp" comment 'SSH'
ufw allow 80/tcp comment 'HTTP (Zertifikate, Weiterleitung)'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTP/3'
ufw --force enable

echo ">> fail2ban"
cat >/etc/fail2ban/jail.d/appzentrale24.local <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
bantime.increment = true

[sshd]
enabled = true
port    = $SSH_PORT
backend = systemd
EOF
systemctl enable fail2ban
systemctl restart fail2ban

echo ">> SSH-Härtung"
# 00- sorgt dafür, dass diese Datei vor anderen Dateien (z. B. 50-cloud-init.conf) gilt.
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-appzentrale24.conf
[ -f "$SSHD_DROPIN" ] && cp "$SSHD_DROPIN" "$SSHD_DROPIN.bak.$(date +%s)"
cat >"$SSHD_DROPIN" <<EOF
Port $SSH_PORT
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers $ADMIN_USER
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
if ! sshd -t; then
  rm -f "$SSHD_DROPIN"
  die "SSH-Konfiguration fehlerhaft - Änderung zurückgenommen, SSH unverändert."
fi
systemctl reload ssh

cat <<EOF

FERTIG. Jetzt bitte:
  1. Dieses Fenster OFFEN lassen.
  2. In einem NEUEN PowerShell-Fenster testen:
       ssh -i \$env:USERPROFILE\.ssh\appzentrale24_ed25519 appadmin@159.195.199.222
  3. Erst wenn das klappt, dieses Fenster schließen.
Falls nicht: im offenen Fenster  sudo rm $SSHD_DROPIN && sudo systemctl reload ssh
EOF

#!/usr/bin/env bash
# AppZentrale24 - Bestandsaufnahme des Servers (nur lesend, ändert nichts)
# Aufruf auf dem Server:  sudo bash 01-bestandsaufnahme.sh | tee bestandsaufnahme.txt
set -u

section() { printf '\n=== %s ===\n' "$1"; }

section "System"
. /etc/os-release; echo "$PRETTY_NAME"; uname -r; uptime
section "Ressourcen"
nproc; free -h; df -h -x tmpfs -x devtmpfs
section "Netzwerk (IPv4/IPv6)"
ip -br addr
section "Offene Ports"
ss -tulpn | grep -v '127.0.0' || true
section "SSH-Konfiguration (wirksam)"
sshd -T 2>/dev/null | grep -E '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|allowusers|maxauthtries) ' || true
section "Hinterlegte Schlüssel"
for u in root appadmin; do
  f=$(getent passwd "$u" | cut -d: -f6)/.ssh/authorized_keys
  printf '%s: ' "$u"; [ -s "$f" ] && echo "$(grep -c . "$f") Schlüssel" || echo "KEINE"
done
section "Benutzer mit Login-Shell"
getent passwd | awk -F: '$7 !~ /(nologin|false|sync)$/ {print $1}'
section "sudo-Gruppe"
getent group sudo
section "Firewall"
command -v ufw >/dev/null && ufw status verbose || echo "ufw nicht installiert"
nft list ruleset 2>/dev/null | head -20 || true
section "Automatische Updates"
dpkg -l unattended-upgrades 2>/dev/null | grep ^ii || echo "unattended-upgrades nicht installiert"
cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null || true
section "Ausstehende Updates"
apt list --upgradable 2>/dev/null | tail -n +2 | wc -l
section "Docker"
command -v docker >/dev/null && docker version --format '{{.Server.Version}}' && docker ps -a || echo "Docker nicht installiert"
section "Laufende Dienste"
systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}'
section "Zeit"
timedatectl | grep -E 'Time zone|synchronized'

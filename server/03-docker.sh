#!/usr/bin/env bash
# AppZentrale24 - Docker Engine + Compose (offizielles Docker-Paketarchiv) und Verzeichnisstruktur
# Aufruf als appadmin:  sudo bash 03-docker.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausführen." >&2; exit 1; }
. /etc/os-release

echo ">> Docker-Paketquelle"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $VERSION_CODENAME
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo ">> Docker-Grundeinstellungen"
# Protokolle begrenzen (sonst läuft die Platte voll), keine Rechteausweitung in Containern,
# Container laufen bei Docker-Updates weiter.
cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "no-new-privileges": true,
  "live-restore": true
}
EOF
systemctl enable docker
systemctl restart docker

echo ">> Verzeichnisse"
BASE=/srv/appzentrale24
install -d -m 0750 -o appadmin -g appadmin "$BASE" "$BASE"/{proxy,begivo,stunden,telefonie,monitoring}
install -d -m 0700 -o root -g root "$BASE/backup" /var/backups/appzentrale24

echo ">> Gemeinsames Proxy-Netz"
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy

# appadmin darf Docker ohne sudo bedienen. Hinweis: das entspricht Root-Rechten;
# appadmin hat ohnehin sudo, daher kein zusätzliches Risiko.
usermod -aG docker appadmin

docker version --format 'Docker {{.Server.Version}}'
docker compose version
echo "FERTIG. Bitte einmal ab- und wieder anmelden, damit die Docker-Gruppe gilt."

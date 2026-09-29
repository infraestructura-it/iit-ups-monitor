#!/usr/bin/env bash
# Instalador de la capa local en Raspberry Pi 5 (Raspberry Pi OS Bookworm 64-bit)
# Uso:  sudo ./deploy/install.sh            (driver Megatec por RS232 / USB-serial)
#       sudo ./deploy/install.sh --with-nut (además instala NUT para UPS USB HID)
set -euo pipefail

APP_DIR=/opt/iit-ups-monitor
SVC_USER=iitups
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WITH_NUT=0
[[ "${1:-}" == "--with-nut" ]] && WITH_NUT=1

[[ $EUID -eq 0 ]] || { echo "Ejecuta con sudo"; exit 1; }
say() { echo -e "\e[36m==>\e[0m $*"; }

say "Paquetes base"
apt-get update -y
apt-get install -y curl git ca-certificates rsync python3 python3-lgpio

# node:sqlite requiere Node >= 22.13
NODE_OK=0
if command -v node >/dev/null; then
  node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)" && NODE_OK=1
fi
if [[ $NODE_OK -eq 0 ]]; then
  say "Instalando Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
say "Node $(node -v)"

if [[ $WITH_NUT -eq 1 ]]; then
  say "Instalando NUT (Network UPS Tools)"
  apt-get install -y nut nut-client nut-server
  if [[ ! -f /etc/nut/.iit-instalado ]]; then   # solo la primera vez: no pisa tus ajustes
    for f in ups.conf upsd.conf upsd.users nut.conf; do
      [[ -f /etc/nut/$f ]] && cp /etc/nut/$f /etc/nut/$f.orig
      cp "$SRC_DIR/deploy/nut/$f" /etc/nut/$f
    done
    touch /etc/nut/.iit-instalado
    chown root:nut /etc/nut/*; chmod 640 /etc/nut/*
  fi
  echo "   Detecta tu UPS con: sudo nut-scanner -U   y ajusta /etc/nut/ups.conf"
fi

say "Usuario de servicio $SVC_USER"
id $SVC_USER >/dev/null 2>&1 || useradd --system --home $APP_DIR --shell /usr/sbin/nologin $SVC_USER
usermod -aG dialout $SVC_USER
getent group gpio >/dev/null && usermod -aG gpio $SVC_USER || true
getent group nut >/dev/null && usermod -aG nut $SVC_USER || true

say "Copiando aplicación a $APP_DIR"
mkdir -p $APP_DIR
rsync -a --delete --exclude node_modules --exclude 'edge/data' --exclude 'edge/.env' "$SRC_DIR/" $APP_DIR/ 2>/dev/null \
  || { apt-get install -y rsync; rsync -a --delete --exclude node_modules --exclude 'edge/data' --exclude 'edge/.env' "$SRC_DIR/" $APP_DIR/; }
mkdir -p $APP_DIR/edge/data
[[ -f $APP_DIR/edge/.env ]] || cp $APP_DIR/edge/.env.example $APP_DIR/edge/.env
cd $APP_DIR/edge && npm ci --omit=dev 2>/dev/null || npm install --omit=dev
chown -R $SVC_USER:$SVC_USER $APP_DIR
chmod 600 $APP_DIR/edge/.env

say "Reglas udev (/dev/ups-serial)"
cp "$SRC_DIR/deploy/udev/99-iit-ups.rules" /etc/udev/rules.d/
udevadm control --reload-rules && udevadm trigger

say "Servicio systemd"
cp "$SRC_DIR/deploy/systemd/iit-ups-monitor.service" /etc/systemd/system/
getent group nut  >/dev/null || sed -i 's/ nut//'  /etc/systemd/system/iit-ups-monitor.service
getent group gpio >/dev/null || sed -i 's/ gpio//' /etc/systemd/system/iit-ups-monitor.service
systemctl daemon-reload
systemctl enable --now iit-ups-monitor
[[ $WITH_NUT -eq 1 ]] && systemctl restart nut-server || true

IP=$(hostname -I | awk '{print $1}')
say "Listo. Dashboard: http://$IP:8080"
echo "   Primer ingreso: journalctl -u iit-ups-monitor | grep -A1 'CONFIGURACIÓN INICIAL'"
echo "   Configuración: sudo nano $APP_DIR/edge/.env   luego  sudo systemctl restart iit-ups-monitor"
echo "   Logs:          journalctl -u iit-ups-monitor -f"

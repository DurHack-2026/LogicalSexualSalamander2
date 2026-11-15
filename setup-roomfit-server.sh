#!/usr/bin/env bash
# Runs on the Vultr GPU server. Installs Room For Improvement to /opt/roomfit and keeps it running with systemd.
set -euo pipefail

SRC=/tmp/roomfit-upload
APP=/opt/roomfit
PORT=3000

echo "== Checking Node.js"
node_ok() {
    command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=6)?0:1)'
}
if ! node_ok; then
    if ! command -v apt-get >/dev/null 2>&1; then
        echo "Node.js 20.6 or newer is needed and this server has no apt-get. Install Node.js, then run this again."
        exit 1
    fi
    echo "Installing Node.js 22..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi
NODE_BIN=$(command -v node)
echo "Using $NODE_BIN ($("$NODE_BIN" --version))"

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is needed for the TRELLIS bridge but was not found."
    exit 1
fi

echo "== Installing Room For Improvement to $APP"
id roomfit >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin roomfit
mkdir -p "$APP/generated_trellis_models"
for file in "$SRC"/*; do
    name=$(basename "$file")
    case "$name" in
        roomfit.env|setup-roomfit-server.sh|update-trellis-api.sh|trellis_api.py) ;;
        *) install -m 644 "$file" "$APP/$name" ;;
    esac
done
install -m 600 "$SRC/roomfit.env" "$APP/.env"
chown -R roomfit:roomfit "$APP"

echo "== Creating the roomfit service"
cat > /etc/systemd/system/roomfit.service <<UNIT
[Unit]
Description=Room For Improvement furniture planner
After=network-online.target
Wants=network-online.target

[Service]
User=roomfit
Group=roomfit
WorkingDirectory=$APP
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable roomfit >/dev/null
systemctl restart roomfit

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    echo "== Opening port $PORT in the firewall"
    ufw allow "$PORT/tcp"
fi


sleep 3
if systemctl is-active --quiet roomfit; then
    echo "== Room For Improvement is running and will restart automatically, including after a reboot."
else
    echo "== Room For Improvement did not start. Recent log:"
    journalctl -u roomfit -n 30 --no-pager || true
    exit 1
fi

if curl -fsS --max-time 5 http://127.0.0.1:7861/api/status >/dev/null 2>&1; then
    echo "== The TRELLIS GPU API is running, so 3D generation is ready."
else
    echo "== Warning: the TRELLIS GPU API (port 7861) is not responding."
    echo "   Room For Improvement will open, but 3D generation will not work until you start trellis_api.py on this server."
fi

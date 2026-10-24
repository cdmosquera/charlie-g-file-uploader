#!/usr/bin/env bash
# Installs Drive Drop on an Ubuntu server (tested target: Azure VM, Ubuntu 26.04 LTS).
#
# Run it from the project folder on the VM:
#   sudo bash setup.sh
#
# What it does:
#   - installs Node.js (>= 20.12) and the Caddy web server (automatic HTTPS)
#   - copies the app to /opt/drive-drop and installs its packages
#   - asks for your settings and saves them to /etc/drive-drop/drive-drop.env
#   - runs the app as a background service that starts on boot
#
# Running it again later updates the app code and keeps your existing settings.
#
# Change settings after the first install (no reinstall needed):
#   sudo bash setup.sh --google     re-enter the Google Client ID and secret
#   sudo bash setup.sh --password   change the admin password
set -euo pipefail

APP_USER=drive-drop
APP_DIR=/opt/drive-drop
DATA_DIR=/var/lib/drive-drop
ENV_DIR=/etc/drive-drop
ENV_FILE=$ENV_DIR/drive-drop.env
SERVICE=drive-drop
PORT=3000

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Please run with sudo:  sudo bash setup.sh"
[[ -f $SRC_DIR/server.js && -f $SRC_DIR/package.json ]] || die "Run this script from inside the project folder."

# ---------- settings ----------

# ask VAR "Question" [secret]  (skips the question if VAR is already set in the environment)
ask() {
  local var=$1 prompt=$2 secret=${3:-} value=${!1:-}
  while [[ -z $value ]]; do
    if [[ -n $secret ]]; then
      read -rsp "$prompt: " value; echo
    else
      read -rp "$prompt: " value
    fi
  done
  printf -v "$var" '%s' "$value"
}

# ask_confirmed VAR "Question" "what"  — hidden input, typed twice so typos are caught
ask_confirmed() {
  local var=$1 prompt=$2 what=$3 again
  while :; do
    ask "$var" "$prompt" secret
    if [[ ${!var} == *"'"* ]]; then
      warn "Please don't use the ' character."
    else
      read -rsp "Repeat $what: " again; echo
      [[ $again == "${!var}" ]] && return
      warn "The ${what}s didn't match, try again."
    fi
    printf -v "$var" '%s' ''
  done
}

ask_password() { ask_confirmed ADMIN_PASSWORD "Admin password for the dashboard" "admin password"; }
ask_google_secret() { ask_confirmed GOOGLE_CLIENT_SECRET "Google Client secret" "Google Client secret"; }

# set_env KEY VALUE  — replaces (or adds) one line in the settings file, keeping its permissions
set_env() {
  local tmp
  [[ $2 == *"'"* ]] && die "The value for $1 can't contain the ' character."
  tmp=$(mktemp)
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  printf "%s='%s'\n" "$1" "$2" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

case "${1:-}" in
  "") ;;
  --google|--password)
    [[ -f $ENV_FILE ]] || die "No settings yet. Run  sudo bash setup.sh  first."
    if [[ $1 == --google ]]; then
      ask GOOGLE_CLIENT_ID "Google Client ID"
      ask_google_secret
      set_env GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
      set_env GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
    else
      ask_password
      set_env ADMIN_PASSWORD "$ADMIN_PASSWORD"
    fi
    systemctl restart "$SERVICE"
    log "Saved and restarted the app."
    [[ $1 == --google ]] && echo "If you changed to a different OAuth client, click \"Connect Google Drive\" in the dashboard again."
    exit 0
    ;;
  -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "Unknown option: $1  (see: bash setup.sh --help)" ;;
esac

if [[ -f $ENV_FILE ]]; then
  log "Existing settings found in $ENV_FILE — keeping them (update mode)"
  BASE_URL=$(grep -E '^BASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d "'\"")
  DOMAIN=${BASE_URL#https://}
else
  log "A few questions (answers are saved to $ENV_FILE)"
  echo "Domain: the public name of this VM, e.g. myuploader.westeurope.cloudapp.azure.com"
  echo "        (Azure portal > your VM > Overview > DNS name, or your own domain pointing to the VM)."
  ask DOMAIN "Domain"
  DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%%/*}
  ask GOOGLE_CLIENT_ID "Google Client ID"
  ask_google_secret
  ask_password
  BASE_URL="https://$DOMAIN"
fi

[[ -n ${DOMAIN:-} ]] || die "No domain configured."

# ---------- system packages ----------

export DEBIAN_FRONTEND=noninteractive

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)'
}

log "Installing system packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg rsync openssl

if ! node_ok; then
  log "Installing Node.js"
  apt-get install -y nodejs npm || true
fi
if ! node_ok; then
  log "Ubuntu's Node.js is too old or missing — installing Node.js 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node_ok || die "Could not install Node.js 20.12 or newer."
command -v npm >/dev/null || apt-get install -y npm
echo "Node.js $(node --version), npm $(npm --version)"

if ! command -v caddy >/dev/null; then
  log "Installing Caddy (web server with automatic HTTPS)"
  if ! apt-get install -y caddy; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
fi

# ---------- app user, code and settings ----------

log "Setting up the app in $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 ||
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"

install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$DATA_DIR"
install -d -m 755 "$APP_DIR"

rsync -a --delete \
  --exclude node_modules --exclude .git --exclude data --exclude .env --exclude .claude \
  "$SRC_DIR/" "$APP_DIR/"
chown -R root:root "$APP_DIR"
(cd "$APP_DIR" && npm ci --omit=dev --no-fund --no-audit)

if [[ ! -f $ENV_FILE ]]; then
  install -d -m 750 -g "$APP_USER" "$ENV_DIR"
  umask 027
  cat > "$ENV_FILE" <<EOF
BASE_URL=$BASE_URL
HOST=127.0.0.1
PORT=$PORT
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET='$GOOGLE_CLIENT_SECRET'
ADMIN_PASSWORD='$ADMIN_PASSWORD'
SESSION_SECRET=$(openssl rand -hex 32)
DATA_DIR=$DATA_DIR
EOF
  umask 022
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

# ---------- background service ----------

log "Installing the $SERVICE service"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Drive Drop file uploader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

# ---------- HTTPS ----------

log "Configuring Caddy for https://$DOMAIN"
CADDYFILE=/etc/caddy/Caddyfile
if [[ -f $CADDYFILE ]] && ! grep -q 'Managed by drive-drop' "$CADDYFILE"; then
  cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
  echo "Backed up the previous Caddyfile."
fi
cat > "$CADDYFILE" <<EOF
# Managed by drive-drop setup.sh
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
systemctl enable caddy >/dev/null
systemctl restart caddy

# ---------- checks ----------

log "Checking the app"
ok=
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/api/admin/status" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ -n $ok ]]; then
  echo "The app is running."
else
  warn "The app did not answer. See the log with:  journalctl -u $SERVICE -n 50"
fi

if ! getent hosts "$DOMAIN" >/dev/null; then
  warn "$DOMAIN does not resolve yet. HTTPS will start working once its DNS points to this VM."
fi

cat <<EOF

────────────────────────────────────────────────────────────
 Done! Remaining steps:

 1. Azure portal > your VM > Networking: allow inbound ports
    80 and 443 (HTTP/HTTPS). Caddy needs both to get the
    HTTPS certificate.

 2. Google Cloud > your OAuth client > Authorized redirect URIs,
    add:  $BASE_URL/auth/google/callback

 3. Open  $BASE_URL/admin , log in and click "Connect Google Drive".

 Useful commands:
   journalctl -u $SERVICE -f        live app log
   sudo systemctl restart $SERVICE  restart the app
   sudo nano $ENV_FILE              change settings (then restart)
   sudo bash setup.sh               update after pulling new code
────────────────────────────────────────────────────────────
EOF

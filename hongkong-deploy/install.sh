#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) != 0 ]]; then
    printf '%s\n' 'Run with sudo bash install.sh /home/ubuntu/amap.private.env' >&2
    exit 1
fi
cd -- "$(dirname -- "$0")"
secret_file=${1:?Supply the private AMap environment file}
test -f "$secret_file"
grep -Eq '^AMAP_JS_KEY="[A-Za-z0-9_-]+"$' "$secret_file"
grep -Eq '^AMAP_SECURITY_CODE="[A-Za-z0-9_-]+"$' "$secret_file"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx curl ca-certificates xz-utils certbot python3-certbot-nginx

if ! /usr/local/bin/node --version 2>/dev/null | grep -q '^v24\.'; then
    case $(uname -m) in
        x86_64) node_arch=x64 ;;
        aarch64) node_arch=arm64 ;;
        *) printf '%s\n' 'Unsupported server CPU architecture' >&2; exit 1 ;;
    esac
    download_dir=$(mktemp -d)
    trap 'rm -rf -- "$download_dir"' EXIT
    (
        cd -- "$download_dir"
        curl --proto '=https' --tlsv1.2 -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
        node_archive=$(awk -v suffix="-linux-$node_arch.tar.xz" '$2 ~ /^node-v24\./ && substr($2, length($2)-length(suffix)+1) == suffix {print $2}' SHASUMS256.txt)
        [[ "$node_archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]]
        curl --proto '=https' --tlsv1.2 -fsSLO "https://nodejs.org/dist/latest-v24.x/$node_archive"
        awk -v file="$node_archive" '$2 == file' SHASUMS256.txt | sha256sum --check -
        install -d /opt/way1024-node
        tar -xJf "$node_archive" --strip-components=1 -C /opt/way1024-node
        ln -sfn /opt/way1024-node/bin/node /usr/local/bin/node
    )
fi

install -d -m 755 /opt/way1024
install -m 644 server.mjs worker.mjs site-assets.mjs /opt/way1024/
install -m 600 "$secret_file" /etc/way1024.env
install -m 644 way1024.service /etc/systemd/system/way1024.service
install -m 644 way1024.nginx /etc/nginx/sites-available/way1024
ln -sfn /etc/nginx/sites-available/way1024 /etc/nginx/sites-enabled/way1024
nginx -t
systemctl daemon-reload
systemctl enable way1024 nginx
systemctl restart way1024
systemctl reload nginx
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/ -o /dev/null
printf '%s\n' 'Website installed. Configure DNS and HTTPS next.'

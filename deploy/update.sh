#!/usr/bin/env bash
# Actualiza la Raspberry desde GitHub conservando .env y la base de datos
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
sudo ./deploy/install.sh "$@"

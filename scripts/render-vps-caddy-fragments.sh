#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env}"
OUTPUT_DIR="${2:-$ROOT_DIR/deploy/vps/caddy.d}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

python3 - "$ENV_FILE" "$OUTPUT_DIR" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
output_dir = Path(sys.argv[2])


def load_env(path: Path):
    values = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().replace("$$", "$")
    return values


env = load_env(env_path)
staging_domain = env.get("STAGING_N8N_DOMAIN", "").strip()
staging_upstream = env.get("STAGING_N8N_UPSTREAM", "").strip()
admin_user = env.get("CADDY_ADMIN_USER", "").strip()
admin_password_hash = env.get("CADDY_ADMIN_PASSWORD_HASH", "").strip()

staging_file = output_dir / "staging.caddy"

if staging_domain and staging_upstream and admin_user and admin_password_hash:
    staging_file.write_text(
        f"""{staging_domain} {{
\tencode zstd gzip

\t@public_endpoints {{
\t\tpath /webhook/* /webhook-test/* /healthz /healthz/*
\t}}

\t@protected {{
\t\tnot path /webhook/* /webhook-test/* /healthz /healthz/*
\t}}

\tbasic_auth @protected {{
\t\t{admin_user} {admin_password_hash}
\t}}

\theader {{
\t\tX-Content-Type-Options \"nosniff\"
\t\tReferrer-Policy \"strict-origin-when-cross-origin\"
\t\tX-Frame-Options \"DENY\"
\t}}

\treverse_proxy {staging_upstream}
}}
""",
        encoding="utf-8",
    )
else:
    staging_file.unlink(missing_ok=True)
PY

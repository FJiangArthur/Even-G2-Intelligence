#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( node_major < 22 )); then
  echo "Helix G2 requires Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

npm run check

if rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!package-lock.json' \
  '(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)' \
  .; then
  echo "Potential credential material found in the workspace." >&2
  exit 1
fi

if rg -n 'VITE_.*(API_KEY|SECRET|TOKEN)' apps/g2-plugin --glob '!README.md' --glob '!.env.example'; then
  echo "Provider credentials must not be compiled into the G2 plugin." >&2
  exit 1
fi

echo "HELIX_G2_GATE_PASSED"

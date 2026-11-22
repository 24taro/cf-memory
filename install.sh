#!/usr/bin/env bash
# cf-memory: deploy to your Cloudflare account and connect your coding agents.
#
#   ./install.sh              deploy, then connect Claude Code and Codex if installed
#   ./install.sh --no-client  deploy only
#
# Safe to run again: it redeploys the same Worker with the same token and
# applies only the migrations that are not applied yet.
set -euo pipefail
cd "$(dirname "$0")"

CLIENTS=1
for arg in "$@"; do
  case "$arg" in
    --no-client) CLIENTS=0 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

for tool in node npm openssl curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but was not found"
done
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major >= 24 || (major === 22 && minor >= 12) ? 0 : 1)'; then
  fail "Node.js 22.12+ on the 22.x line, or Node.js 24+, is required (found $(node -v))"
fi

say "Installing dependencies"
npm ci --no-audit --no-fund

wrangler() { node node_modules/wrangler/bin/wrangler.js "$@"; }

say "Checking the Cloudflare login"
# `wrangler whoami` exits 0 even when logged out, so read what it says.
logged_out() { wrangler whoami 2>&1 | grep -qi "not authenticated"; }
if logged_out; then
  echo "A browser window opens for the Cloudflare login. Choose Allow, then come back here."
  wrangler login || true
  if logged_out; then fail "not logged in to Cloudflare. Run 'npx wrangler login' and then this script again"; fi
fi

# The owner's token. Kept in this checkout, readable only by you, never committed.
SECRETS_FILE=".cf-memory.secrets"
if [ ! -s "$SECRETS_FILE" ]; then
  say "Generating the API token ($SECRETS_FILE)"
  (umask 077; printf 'API_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$SECRETS_FILE")
fi
chmod 600 "$SECRETS_FILE"
TOKEN=$(sed -n 's/^API_TOKEN=//p' "$SECRETS_FILE" | head -n 1)
export -n TOKEN
[ "${#TOKEN}" -ge 32 ] || fail "$SECRETS_FILE holds no API_TOKEN of 32 or more characters; delete it and run again"

say "Deploying the Worker (creates the D1 databases and the R2 bucket on first run)"
DEPLOY_LOG=$(mktemp)
trap 'rm -f "$DEPLOY_LOG"' EXIT
if ! CI=true wrangler deploy --secrets-file "$SECRETS_FILE" \
    --var "BUILD_GIT_SHA:$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
    --var "BUILD_DATE:$(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>&1 | tee "$DEPLOY_LOG"; then
  fail "wrangler deploy failed (see the output above)"
fi
URL=$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -n 1 || true)
[ -n "$URL" ] || fail "the deploy printed no workers.dev address. Open Workers & Pages in the Cloudflare dashboard once to choose your workers.dev subdomain, then run this again"

say "Applying database migrations"
CI=true wrangler d1 migrations apply DB --remote
CI=true wrangler d1 migrations apply LOGS --remote

say "Checking $URL"
OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -fsS -m 15 -H @- "$URL/api/v1/whoami" 2>/dev/null | grep -q '"token_status":"active"'; then OK=1; break; fi
  sleep 3
done
[ "$OK" = 1 ] || fail "the Worker is deployed at $URL but did not accept the token. Run this script again in a minute"
echo "The server accepts your token."

CONNECTED=""
if [ "$CLIENTS" = 1 ] && command -v claude >/dev/null 2>&1; then
  say "Connecting Claude Code"
  claude mcp remove cf-memory --scope user >/dev/null 2>&1 || true
  # add-json accepts stdin, so the credential never appears in a process argument.
  printf '%s' "$TOKEN" |
    node -e '
      const token = require("node:fs").readFileSync(0, "utf8");
      const config = { type: "http", url: process.argv[1], headers: { Authorization: "Bearer " + token } };
      process.stdout.write(JSON.stringify(config));
    ' "$URL/mcp" |
    claude mcp add-json --scope user cf-memory -
  node cf-memory-agent/scripts/agent.mjs install --client claude-code >/dev/null
  CONNECTED="$CONNECTED claude-code"
fi
CODEX=0
if [ "$CLIENTS" = 1 ] && command -v codex >/dev/null 2>&1; then
  say "Connecting Codex"
  codex mcp remove cf-memory >/dev/null 2>&1 || true
  codex mcp add cf-memory --url "$URL/mcp" --bearer-token-env-var CF_MEMORY_ACCESS_TOKEN
  node cf-memory-agent/scripts/agent.mjs install --client codex >/dev/null
  CONNECTED="$CONNECTED codex"
  CODEX=1
fi

cat <<DONE

cf-memory is running.

  Server      $URL
  MCP         $URL/mcp
  API token   $(pwd)/$SECRETS_FILE
  Connected  ${CONNECTED:- none}

DONE
if [ -z "$CONNECTED" ] && [ "$CLIENTS" = 1 ]; then
  echo "Neither Claude Code nor Codex was found. Install one and run this script again."
fi
if [ -n "$CONNECTED" ]; then
  echo "Restart your agent. It now keeps each prompt and final reply, and recalls"
  echo "related notes and conversations at the start of every prompt."
fi
if [ "$CODEX" = 1 ]; then
  printf -v QUOTED_SECRETS_FILE '%q' "$PWD/$SECRETS_FILE"
  cat <<DONE

Codex reads the token from the environment. Add these two lines to your shell
profile, then approve the new hooks once in Codex with /hooks:

  export CF_MEMORY_MCP_URL="$URL/mcp"
  export CF_MEMORY_ACCESS_TOKEN="\$(sed -n 's/^API_TOKEN=//p' $QUOTED_SECRETS_FILE)"
DONE
fi
echo
echo "Check any time:  node cf-memory-agent/scripts/agent.mjs doctor"

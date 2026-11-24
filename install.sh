#!/usr/bin/env bash
# cf-memory: deploy to your Cloudflare account and connect your coding agents.
#
#   ./install.sh              deploy, then connect Claude Code and Codex if installed
#   ./install.sh --no-client  deploy only
#   ./install.sh --existing-url URL  adopt an older checkout at its original Worker URL
#   ./install.sh --rotate-token      rotate the token on this checkout's verified Worker
#
# Safe to run again: it redeploys the same Worker with the same token and
# applies only the migrations that are not applied yet.
set -euo pipefail
cd "$(dirname "$0")"

CLIENTS=1
EXISTING_URL=""
ROTATE_TOKEN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-client) CLIENTS=0 ;;
    --rotate-token) ROTATE_TOKEN=1 ;;
    --existing-url)
      [ "$#" -gt 1 ] && [[ -n "$2" && "$2" != --* ]] || { echo "--existing-url requires the original Worker URL" >&2; exit 2; }
      EXISTING_URL=$2
      shift
      ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

if [ "$ROTATE_TOKEN" = 1 ] && [ -n "$EXISTING_URL" ]; then
  fail "use --existing-url to verify the original installation before running --rotate-token"
fi

for tool in node npm openssl curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but was not found"
done
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major >= 24 || (major === 22 && minor >= 12) ? 0 : 1)'; then
  fail "Node.js 22.12+ on the 22.x line, or Node.js 24+, is required (found $(node -v))"
fi

CLAUDE=0
if [ "$CLIENTS" = 1 ] && command -v claude >/dev/null 2>&1; then
  claude_requirement="Claude Code 2.1.327 or later is required. Update Claude Code or run './install.sh --no-client' to deploy only."
  if ! claude_version=$(claude --version) || ! [[ "$claude_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)([[:space:]]|$) ]]; then
    fail "could not determine the Claude Code version. $claude_requirement"
  fi
  major=${BASH_REMATCH[1]}
  minor=${BASH_REMATCH[2]}
  patch=${BASH_REMATCH[3]}
  if (( 10#$major < 2 || (10#$major == 2 && (10#$minor < 1 || (10#$minor == 1 && 10#$patch < 327))) )); then
    fail "found Claude Code $major.$minor.$patch. $claude_requirement"
  fi
  CLAUDE=1
fi

say "Installing dependencies"
npm ci --no-audit --no-fund

wrangler() { node node_modules/wrangler/bin/wrangler.js "$@"; }

say "Checking the Cloudflare login"
# `wrangler whoami` exits 0 even when logged out, so read what it says.
logged_out() { wrangler whoami 2>&1 | grep -qi "not authenticated"; }
login_required() { fail "not logged in to Cloudflare. Run 'npx wrangler login' and then this script again"; }
if logged_out; then
  if [[ "${CI:-}" == true || "${CI:-}" == 1 ]]; then login_required; fi
  echo "A browser window opens for the Cloudflare login. Choose Allow, then come back here."
  wrangler login || true
  if logged_out; then login_required; fi
fi

# The owner's token. Kept in this checkout, readable only by you, never committed.
SECRETS_FILE=".cf-memory.secrets"
INSTALL_CLAIM=".cf-memory.install-claim"
DEPLOYMENT_FILE=".cf-memory.deployment.json"
say "Verifying the Cloudflare account and Worker"
if [ "$ROTATE_TOKEN" = 1 ]; then
  target=$(CI=true node scripts/reserve-worker.mjs rotate "$DEPLOYMENT_FILE" "$SECRETS_FILE") || fail "could not complete token rotation"
else
  target=$(CI=true node scripts/reserve-worker.mjs prepare "$INSTALL_CLAIM" "$DEPLOYMENT_FILE" "$SECRETS_FILE" "$EXISTING_URL") ||
    fail "could not prepare the selected Worker; no token was uploaded"
fi
read -r mode account_id worker_name api_url URL worker_id <<< "${target##*$'\n'}"
[[ "$account_id" =~ ^[[:xdigit:]]{32}$ && "$worker_name" =~ ^[a-z0-9-]+$ &&
   "$worker_id" =~ ^[[:xdigit:]]{32}$ && -n "$api_url" && "$URL" =~ ^https://[a-z0-9.-]+\.workers\.dev$ ]] ||
  fail "could not confirm the Cloudflare account, Worker, and URL"
export CLOUDFLARE_ACCOUNT_ID="$account_id" CLOUDFLARE_API_BASE_URL="$api_url"
set -- --name "$worker_name"
if [ "$mode" = first ]; then
  if [ ! -e "$SECRETS_FILE" ]; then
    say "Generating the API token ($SECRETS_FILE)"
    (umask 077; set -C; generated_token=$(openssl rand -hex 32); printf 'API_TOKEN=%s\n' "$generated_token" > "$SECRETS_FILE")
  fi
  set -- --secrets-file "$SECRETS_FILE" "$@"
elif [ "$mode" != update ] && [ "$mode" != rotated ]; then
  fail "could not confirm the deployment mode"
fi
chmod 600 "$SECRETS_FILE"
TOKEN=$(sed -n 's/^API_TOKEN=//p' "$SECRETS_FILE" | head -n 1)
export -n TOKEN
[ "${#TOKEN}" -ge 32 ] || fail "$SECRETS_FILE holds no API_TOKEN of 32 or more characters"

if [ "$mode" != rotated ]; then
  say "Deploying the Worker (creates the D1 databases and the R2 bucket on first run)"
  if ! CI=true wrangler deploy "$@" \
    --var "BUILD_GIT_SHA:$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
    --var "BUILD_DATE:$(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
    fail "wrangler deploy failed (see the output above)"
  fi

  say "Verifying the deployed D1 and R2 bindings"
  CI=true node scripts/reserve-worker.mjs record-storage "$DEPLOYMENT_FILE" "$worker_id" ||
    fail "deployed storage could not be verified; database migrations have not been run"

  say "Applying database migrations"
  CI=true wrangler d1 migrations apply DB --remote
  CI=true wrangler d1 migrations apply LOGS --remote

  say "Checking $URL"
  OK=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -q -fsS -m 15 -H @- "$URL/api/v1/whoami" 2>/dev/null | grep -q '"token_status":"active"'; then OK=1; break; fi
    sleep 3
  done
  [ "$OK" = 1 ] || fail "the Worker is deployed at $URL but did not accept the token. Run this script again in a minute"
  node scripts/reserve-worker.mjs ready "$DEPLOYMENT_FILE" "$worker_id"
  rm -f "$INSTALL_CLAIM"
fi
echo "The server accepts your token."

CONNECTED=""
CLIENT_FAILED=0
client_error() {
  printf 'error: %s\n' "$*" >&2
  CLIENT_FAILED=1
}
if [ "$CLAUDE" = 1 ]; then
  say "Connecting Claude Code"
  if printf '%s' "$TOKEN" | node scripts/register-claude-mcp.mjs "$URL/mcp"; then
    echo "Claude Code MCP server registered."
    if node cf-memory-agent/scripts/agent.mjs install --client claude-code >/dev/null; then
      echo "Claude Code hooks installed."
      CONNECTED="$CONNECTED claude-code"
    else
      client_error "Claude Code hook setup failed. Run 'node cf-memory-agent/scripts/agent.mjs install --client claude-code' for the plugin report."
    fi
  else
    client_error "Claude Code MCP registration failed."
  fi
fi
CODEX=0
if [ "$CLIENTS" = 1 ] && command -v codex >/dev/null 2>&1; then
  say "Connecting Codex"
  if codex mcp add cf-memory --url "$URL/mcp" --bearer-token-env-var CF_MEMORY_ACCESS_TOKEN; then
    echo "Codex MCP server registered."
    CODEX=1
    if node cf-memory-agent/scripts/agent.mjs install --client codex >/dev/null; then
      echo "Codex hooks installed."
      CONNECTED="$CONNECTED codex"
    else
      client_error "Codex hook setup failed. Run 'node cf-memory-agent/scripts/agent.mjs install --client codex' for the hook report."
    fi
  else
    client_error "Codex MCP registration failed."
  fi
fi

cat <<DONE

cf-memory is running.

  Server      $URL
  MCP         $URL/mcp
  API token   $(pwd)/$SECRETS_FILE
  Connected  ${CONNECTED:- none}

DONE
if [ -z "$CONNECTED" ] && [ "$CLIENTS" = 1 ] && [ "$CLIENT_FAILED" = 0 ]; then
  echo "Neither Claude Code nor Codex was found. Install one and run this script again."
fi
if [ -n "$CONNECTED" ]; then
  echo "Restart your agent to record prompts and replies and recall related notes."
  echo "A new session also receives the previous session's last reply for this Git repository."
fi
if [ "$CODEX" = 1 ]; then
  printf -v QUOTED_SECRETS_FILE '%q' "$PWD/$SECRETS_FILE"
  cat <<DONE

Codex reads the token from the environment. Add these two lines to your shell
profile. After installing the hooks, approve them once in Codex with /hooks:

  export CF_MEMORY_MCP_URL="$URL/mcp"
  export CF_MEMORY_ACCESS_TOKEN="\$(sed -n 's/^API_TOKEN=//p' $QUOTED_SECRETS_FILE)"
DONE
fi
echo
echo "Check any time:  node cf-memory-agent/scripts/agent.mjs doctor"
exit "$CLIENT_FAILED"

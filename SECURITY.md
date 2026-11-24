# Security

## Reporting a problem

Please report vulnerabilities through GitHub's private vulnerability reporting
on this repository (Security → Report a vulnerability), not in a public issue.

## Trust model

**Single-owner mode (the default).** One fixed token, set as the `API_TOKEN`
secret, is the owner with every scope. Anyone who has the token can read and
write everything in the instance. It is compared in constant time, and a token
shorter than 32 characters is refused.

To rotate it, select the original Cloudflare account. After the new token is
uploaded the old one stops working, so refresh the connected clients:

```bash
(umask 077; set -C; token=$(openssl rand -hex 32) &&
  printf 'API_TOKEN=%s\n' "$token" > .cf-memory.secrets.next) &&
  sed -n 's/^API_TOKEN=//p' .cf-memory.secrets.next | npx wrangler secret put API_TOKEN &&
  mv .cf-memory.secrets.next .cf-memory.secrets &&
  ./install.sh
```

Restart the clients. If you use the standalone CLI, provide the new token on
standard input to `login --key-stdin`. Give it an explicit new token when the
server origin changes.

**What leaves your machine.** The hook plugin sends prompts, final replies, one
line per tool action and the head of failed output to your Worker, and nowhere
else. Text is scrubbed for common secret formats before it is written to the
local spool. Scrubbing is pattern matching: it reduces what is stored, it does
not guarantee that no secret is stored.

**Recalled text is data.** Notes and past conversations are put back into the
agent's context. An agent can be misled by what it reads, including text it
saved itself from a web page or a file.

**Experimental team mode.** An instance is one group of invited members who trust each
other; it is not a boundary between mutually distrusting tenants.

- Shared notes can be edited by any member. Recall labels and fences text from
  another member and text whose current revision lacks a verifiable editor.
- The authorization server must return only verified email addresses: the first
  token whose address equals an invited, not yet linked row is linked to it.
- A `machine:` token acts as the instance owner.
- A Bearer token reads only with `notes:read`.
- On macOS with Keychain OAuth, queued entries can reach the previous account
  if you queue them under a new account on the same server and switch back
  before the new account's first successful flush. Keep one account per client
  profile, or use an explicit token so entries can be tied to the credential
  when queued.

**Remote images.** A note may embed an `https:` image from any host. Opening the
page in a browser requests it, so that host sees the reader's IP address.

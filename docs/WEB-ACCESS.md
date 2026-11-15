# Web pages behind Cloudflare Access

The Worker also serves web pages for reading and editing notes. They are closed
until you put Cloudflare Access in front of them: the API token is for agents,
and a browser signs in through Access.

You do not need a domain of your own. The `workers.dev` address works, as long
as the Access application covers only the `/access` path. An application that
covers the whole address would also block your agents' token requests to `/mcp`.

1. In the Cloudflare dashboard, go to Zero Trust → Access controls →
   Applications → Create new application → Self-hosted and private.

2. Under Public hostnames, choose Switch to custom input and enter your
   Worker's address followed by `/access`:

   ```
   cf-memory.<your-subdomain>.workers.dev/access
   ```

   Do not use Add Workers: it protects the whole Worker, `/mcp` included.

3. Under Access policies, choose Create new policy. Set the selector to Emails,
   enter your own address, name the policy and save it. Then choose Create.

4. Open the application again from the list and copy the Application Audience
   (AUD) Tag at the bottom of the Additional settings tab. Your team domain is
   `<your-team-name>.cloudflareaccess.com`; it is the host of the sign-in page.

5. Add three variables to `wrangler.jsonc` under `vars`:

   ```jsonc
   "ACCESS_TEAM_DOMAIN": "<your-team-name>.cloudflareaccess.com",
   "ACCESS_AUD": "<application audience tag>",
   "OWNER_EMAIL": "<the address you sign in with>"
   ```

   `OWNER_EMAIL` is required once `ACCESS_AUD` is set: without it every request
   fails.

6. Run `./install.sh --no-client`, then open
   `https://cf-memory.<your-subdomain>.workers.dev/access` and sign in.

Only `/access` is behind Access at the edge. On every other path the Worker
itself verifies the Access token's signature, team domain and audience, so a
request without a valid one gets nothing. An address that is not the owner's,
and was not invited, is refused.

## With a domain of your own

Give the Worker a hostname in `wrangler.jsonc`, and keep the `workers.dev`
address your agents already use:

```jsonc
"routes": [{ "pattern": "memory.example.com", "custom_domain": true }],
"workers_dev": true
```

Then add `memory.example.com` with the path `access` as a second public
hostname of the same Access application.

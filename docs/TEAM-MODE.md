# Team mode

Single-owner mode needs none of this. Use team mode when several people share
one instance and each needs their own account and scopes.

In team mode the Worker accepts opaque OAuth access tokens and asks an
authorization server whether each one is live. You provide that server as
another Worker in the same Cloudflare account.

## Configuration

```jsonc
"vars": {
  "AUTH_ISSUER": "https://auth.example.com",
  "RESOURCE_URI": "https://<your worker>/mcp"
},
"services": [{ "binding": "AUTH", "service": "<your authorization Worker>" }]
```

and the secret `INTROSPECTION_SECRET` (32 characters or more).

## What the authorization Worker must answer

The Worker calls `POST /introspect` on the `AUTH` binding with
`Authorization: Bearer <INTROSPECTION_SECRET>` and a form body `token=<token>`.
The answer is JSON:

```json
{ "active": true, "sub": "user:<id>", "scope": "notes:read notes:write", "aud": ["https://<your worker>/mcp"], "email": "person@example.com" }
```

- `aud` must contain `RESOURCE_URI`, or the token is refused.
- `sub` is `user:<id>` for a person or `machine:<name>` for automation. A
  machine token acts as the instance owner.
- `email` must be a verified address. It links a person's first token to the
  row their invitation created.
- Scopes are `notes:read`, `notes:write` and `admin`.

Any failure, including the authorization Worker being unreachable, is treated
as "not authorised".

People are invited by the owner from the web pages
([Web pages behind Cloudflare Access](WEB-ACCESS.md)). The fixed `API_TOKEN`
keeps working beside team mode.

# Login sync Worker

The cloud half of AgentHydra's login sync (`server/src/core/cli-login-sync.ts`): a Cloudflare
Worker that keeps your CLI logins the same on your PCs, so a login can stay signed in on two PCs at
once. When one PC refreshes a login, it uploads the new one here and the other PC picks it up within
about a minute.

It never sees a login. Each PC encrypts every login (AES-256-GCM) with a key that stays on your PCs,
and this Worker stores the ciphertext with a version number. It knows only the SHA-256 of its access
token, never the token.

## Deploy your own

1. Create a D1 database (Cloudflare dashboard, Workers & Pages > D1, or `wrangler d1 create
   agenthydra-login-sync`). The Worker creates its table on first use.
2. Make an access token and its hash, and keep the token somewhere private:

   ```bash
   bun -e "const t=require('crypto').randomBytes(32).toString('base64url');console.log('token',t);console.log('sha256',require('crypto').createHash('sha256').update(t).digest('hex'))"
   ```

3. Deploy `worker.js` as an ES-module Worker with two bindings: the D1 database as `DB`, and a plain
   text variable `TOKEN_SHA256` set to the hash. Turn on its workers.dev address (or give it a route).
4. In AgentHydra: CLI tab, the cloud button (Login sync), "Or set up a new store": paste the
   Worker's address and the token. Then "Copy pairing code" and paste it into Login sync on your
   other PC.

`GET /v1/health` answers `{"ok":true}` without a token, to check the address.

## What it serves

| Route | What |
| --- | --- |
| `GET /v1/logins` | every login's id, version and non-secret meta (instance number, expiry, which PC) |
| `GET /v1/logins/:id` | one login's encrypted blob |
| `PUT /v1/logins/:id` | `{version, blob, meta}`: stored as version+1 when `version` is the current one (0 for new); else 409 with the current version |
| `DELETE /v1/logins/:id?version=n` | removes it at that version |

Every route but `/v1/health` needs `Authorization: Bearer <token>`.

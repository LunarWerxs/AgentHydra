// REST surface for local API auth (server/src/local-auth.ts): the pairing handshake a browser
// uses to earn a key, and the paired-client list the owner manages. status/request/verify are on
// local-auth's open list; codes/clients/revoke/stream-ticket need a credential once enforcement
// is on, which makes the CLI (holding the cookie file) the trusted place a pairing code is shown.
import type { Context, Hono } from "hono";
import {
  completePairing,
  isAuthorized,
  listPairedClients,
  mintStreamTicket,
  pendingPairings,
  revokePairedClient,
  startPairing,
} from "../local-auth";
import { ROUTES } from "../routes";
import { type CreateAppOptions, fail, readBody } from "./core";

function handleStatus(c: Context, options: CreateAppOptions) {
  const required = options.requireAuth === true;
  return c.json({
    required,
    authorized: !required || isAuthorized(c, { trayToken: options.shutdownToken }),
  });
}

async function handleRequest(c: Context) {
  const body = await readBody(c);
  return c.json(startPairing(typeof body.label === "string" ? body.label : ""));
}

async function handleVerify(c: Context) {
  const body = await readBody(c);
  if (typeof body.requestId !== "string" || typeof body.code !== "string")
    return fail(c, "requestId and code are required");
  const result = completePairing(body.requestId, body.code);
  if (!result.ok) return fail(c, result.reason, 403);
  // The key goes back in the body, once, for the GUI to keep in its own origin's localStorage and
  // send as a Bearer header. Deliberately not a cookie: cookies ignore the port, so every other
  // localhost server the browser visits (the user's dev servers) would receive it.
  return c.json({ clientId: result.client.id, label: result.client.label, key: result.key });
}

function handleRevoke(c: Context) {
  const id = c.req.param("id") ?? "";
  if (!revokePairedClient(id)) return fail(c, "unknown paired client", 404);
  return c.json({ ok: true });
}

export function registerPairingRoutes(app: Hono, options: CreateAppOptions) {
  app.get(ROUTES.pairingStatus, (c) => handleStatus(c, options));
  app.post(ROUTES.pairingRequest, handleRequest);
  app.post(ROUTES.pairingVerify, handleVerify);
  app.get(ROUTES.pairingCodes, (c) => c.json(pendingPairings()));
  app.get(ROUTES.pairingClients, (c) => c.json(listPairedClients()));
  app.post(ROUTES.pairingStreamTicket, (c) => c.json(mintStreamTicket()));
  app.delete(ROUTES.pairingClient.pattern, handleRevoke);
}

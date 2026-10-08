// Cloudflare's Clef decision models behind a Worker, for hswarm's Jev stand-in (decisions.stand_in_answers).
//
// Why a Worker: Workers AI's REST API needs a Cloudflare API token, and an account whose only credential is an
// OAuth login (rotated hourly, unable to mint a narrower token) has none to keep. A Worker reaches Workers AI
// through its AI binding with no token at all, so this one forwards hswarm's TypeSafe-shaped request to Clef and
// checks one shared secret instead.
//
// Deploy with an AI binding named AI and a secret HSWARM_CLEF_SECRET, then add `<worker host>:<secret>` to
// ~/.hswarm/secrets/cloudflare_api_keys. POST /clef or /clef-flash with `Authorization: Bearer <secret>` and
// TypeSafe's {state, model, questions}; the answer comes back in Workers AI's REST envelope, {result, success}.

const MODELS = new Set(['clef', 'clef-flash'])
const enc = new TextEncoder()

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function authorised(request, secret) {
  const given = enc.encode((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''))
  const want = enc.encode(secret || '')
  return (
    want.byteLength > 0 &&
    given.byteLength === want.byteLength &&
    crypto.subtle.timingSafeEqual(given, want)
  )
}

export default {
  async fetch(request, env) {
    if (!authorised(request, env.HSWARM_CLEF_SECRET))
      return reply(401, { success: false, errors: [{ message: 'unauthorised' }] })
    const model = new URL(request.url).pathname.replace(/^\/+/, '')
    if (request.method !== 'POST' || !MODELS.has(model))
      return reply(404, { success: false, errors: [{ message: 'POST /clef or /clef-flash' }] })
    let body
    try {
      body = await request.json()
    } catch {
      return reply(400, { success: false, errors: [{ message: 'the body is not JSON' }] })
    }
    try {
      const result = await env.AI.run(`@cf/cloudflare/${model}`, { ...body, model })
      return reply(200, { result, success: true })
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300)
      // Capacity and timeouts heal on a retry; anything else (a malformed question, the day's free neurons spent)
      // fails the same way again, so it answers a status hswarm does not retry.
      return reply(/capacity|timed? ?out|unavailable|overloaded/i.test(message) ? 503 : 400, {
        success: false,
        errors: [{ message }],
      })
    }
  },
}

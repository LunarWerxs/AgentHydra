#!/usr/bin/env bun
// orchestrate.mjs - the standalone orchestrator's entry point.
//
// TODAY IT ONLY OBSERVES. That is a deliberate choice, not an unfinished one: both previous
// orchestrators failed by acting on chats they had misjudged, so the actuator is being rebuilt
// from nothing and nothing here touches a chat until it is. See README.md.
//
// It talks to the AgentHydra daemon over HTTP and holds no state of its own.

const BASE = process.env.AGENTHYDRA_URL ?? 'http://127.0.0.1:7787'
const JSON_OUT = process.argv.includes('--json')

/** One GET. A failure is reported as a failure - never as an empty fleet. */
async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

/**
 * A chat's last assistant turn OFFERS TO CARRY ON, so it is waiting to be told to - not finished.
 *
 * This is the single rule v2 lacked, and the reason it archived work that was waiting on a person:
 * it asked only whether the text ended in a '?'. "Say the word and I'll start" never does.
 */
const OFFER_TO_CONTINUE =
  /\b(say the word|say go|give me the word|given the word|on your word|ready when you are|let me know and I|want me to|shall I)\b/i

export function offersToContinue(text) {
  return OFFER_TO_CONTINUE.test(String(text ?? ''))
}

async function census() {
  const health = await api('/api/health')
  const [fleet, sessions] = await Promise.all([api('/api/fleet'), api('/api/sessions')])

  const rows = Array.isArray(sessions) ? sessions : (sessions.sessions ?? [])
  const visible = rows.filter((s) => !s.archived)
  const instances = fleet.instances ?? []
  const open = instances.filter((i) => i.isRunning)

  // THE SANITY RAIL (owner law): one or zero open instances means detection is broken, not that
  // the fleet is quiet. A census that starts wrong poisons every decision after it.
  const plausible = open.length >= 2

  const waiting = visible.filter((s) => offersToContinue(s.last_text_preview))

  return {
    daemon: { url: BASE, version: health.version, distribution: health.distribution },
    sanity: {
      plausible,
      why: plausible
        ? `${open.length} open instances - a plausible fleet`
        : `${open.length} open instance(s) - INVESTIGATE instance detection before trusting anything below`,
    },
    instances: {
      total: instances.length,
      open: open.map((i) => ({
        num: i.num,
        name: i.name,
        plan: i.account?.planLabel ?? null,
        weeklyPct: i.usage?.weeklyPct ?? null,
      })),
    },
    chats: { total: rows.length, visible: visible.length, archived: rows.length - visible.length },
    // ⛔ A LOWER BOUND, NOT AN ANSWER. `last_text_preview` is truncated by the daemon (~140
    // chars), and the offer to carry on is usually the LAST line of a long recap - so it is
    // normally cut off. A zero here means "nothing found in the previews", never "nothing is
    // waiting". Reading the real thing needs the transcript tail, which the rewrite will do.
    // Saying this out loud is the point: the previous orchestrator's defining failure was a
    // cheap proxy reported as a verdict.
    waitingScan: {
      source: 'truncated last_text_preview',
      complete: false,
      why: 'previews are cut short, so an offer at the end of a recap is usually invisible here',
    },
    // Reported, never acted on. The whole point of this version.
    waitingOnAPerson: waiting.map((s) => ({
      sessionId: s.session_id,
      title: s.title,
      instance: s.instance,
      preview: String(s.last_text_preview ?? '').slice(0, 160),
    })),
  }
}

function render(c) {
  const L = []
  L.push(`daemon    ${c.daemon.version} (${c.daemon.distribution}) at ${c.daemon.url}`)
  L.push(`sanity    ${c.sanity.plausible ? 'OK' : '** NOT PLAUSIBLE **'} - ${c.sanity.why}`)
  L.push(`instances ${c.instances.open.length} open of ${c.instances.total}`)
  for (const i of c.instances.open) {
    L.push(`            #${i.num} ${i.name} - ${i.plan ?? 'plan unknown'}, weekly ${i.weeklyPct ?? '-'}%`)
  }
  L.push(`chats     ${c.chats.visible} visible, ${c.chats.archived} archived, ${c.chats.total} total`)
  L.push('')
  if (c.waitingOnAPerson.length === 0) {
    L.push('No chat is waiting-on-a-person IN THE PREVIEWS - which is a lower bound, not a clean')
    L.push('fleet: previews are truncated, and the offer to carry on is usually the last line of a')
    L.push('long recap, so it is normally cut off. Reading the real answer needs transcript tails.')
  } else {
    L.push(`${c.waitingOnAPerson.length} chat(s) OFFER TO CARRY ON and are waiting to be told to:`)
    for (const w of c.waitingOnAPerson) {
      L.push(`  - [${w.instance}] ${w.title}`)
      L.push(`      ${w.preview}`)
    }
    L.push('')
    L.push('These are NOT finished. Nothing here archives them.')
  }
  return L.join('\n')
}

try {
  const c = await census()
  console.log(JSON_OUT ? JSON.stringify(c, null, 2) : render(c))
  process.exit(c.sanity.plausible ? 0 : 2)
} catch (err) {
  // A failed read must never print as a clean fleet.
  console.error(`census FAILED: ${err.message}`)
  console.error(`Is the AgentHydra daemon running? Try: curl ${BASE}/api/health`)
  process.exit(1)
}

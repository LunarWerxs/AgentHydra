/**
 * Regenerate the README screenshots.
 *
 *   bun run screenshots            # start a private web server, shoot, install into .github/screenshots
 *   bun run screenshots -- --keep  # stop after tmp/screenshots, so you can eyeball before installing
 *   bun run screenshots -- --url http://localhost:5173   # reuse a server you already have running
 *
 * WHY IT LOOKS LIKE THIS
 *
 * The images are public, so nothing real may appear in them: no session titles, account
 * addresses, project names or filesystem paths. The obvious approach (point a throwaway daemon
 * at a synthetic home directory) means standing up a whole second daemon and still risks the
 * real one being picked up. This does something stricter instead: the page's `fetch` is replaced
 * before the SPA boots (page-fixtures.js), so EVERY /api/ response is invented and no daemon runs
 * at all. The driver then asserts that zero /api/ requests escaped to the network, so a fixture
 * gap can never silently leak live data into a committed image. Shots are staged in tmp/ and only
 * copied into .github/screenshots once that assertion has passed.
 *
 * Capture is Chrome over the DevTools protocol rather than a screenshot library: it is the only
 * dependency-free way to drive the app (click into a session, open the queue drawer) and size the
 * frame per view. Each view has its own max-width shell, so one viewport would leave most shots
 * as empty margin.
 *
 * Every shot declares an `expect` predicate that must hold before the shutter fires. That is not
 * ceremony: an earlier hand-rolled version of this shipped a transcript pane full of empty
 * skeletons because the fixture shape was wrong, and nothing caught it but a human eyeball.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const INSTALL_DIR = join(REPO, '.github', 'screenshots');
const TMP_DIR = join(REPO, 'tmp', 'screenshots');
const PROFILE_DIR = join(REPO, 'tmp', 'screenshot-profile');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};

const KEEP = flag('keep');
// Shots are ALWAYS written to the staging dir first. Nothing reaches .github/screenshots until the
// escape assertion has passed, so a fixture gap can never leave a leaked image in the committed
// directory for someone to `git add -A` by accident.
const STAGE = TMP_DIR;
const EXTERNAL_URL = opt('url');
/** Private port: a dev session on the default 5173 must not be disturbed, or shot. */
const PORT = Number(opt('port') ?? 5199);
const SCALE = 2;
/** A shot smaller than this never contains a rendered app; treat it as a failed capture. */
const MIN_PNG_BYTES = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- shot list --------------------------------------------------------------------------------
// Each shot is a list of `steps` (a synchronous expression to run in the page, then how long to
// let the UI settle) plus an `expect` predicate that must hold before the shutter fires.
//
// Steps are deliberately SYNCHRONOUS with the waiting done here rather than in the page. An
// earlier version used an async page expression with `awaitPromise`, and Chrome intermittently
// collected the pending promise while the view transition re-rendered ("Promise was collected").
//
// Viewports differ per shot because the shell is max-width capped (base 1000, wide 1600 once a
// transcript is open, plus a 480px queue drawer); one size would frame most shots as margin.
const clickIn = (scope, label) =>
  `(() => { const b=[...document.querySelectorAll('${scope} button')].find(x=>/${label}/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`;
const openFirstSession = `(() => { const b=[...document.querySelectorAll('aside button')].find(x=>/mb-1\\.5 w-full rounded-lg/.test(x.className||'')); if(b) b.click(); return !!b; })()`;

const SHOTS = [
  {
    name: 'sessions',
    viewport: [1440, 900],
    steps: [{ eval: openFirstSession, wait: 3500 }],
    // Real turns rendered, not the loading skeletons. Counting `.rounded-2xl` alone does NOT
    // establish that: SessionsView renders four Skeletons carrying the same class while the tail
    // loads, and the fixture supplies exactly four turns, so a bare count is satisfied identically
    // by the skeleton state (4) and the loaded state (4). Exclude skeletons by their data-slot AND
    // assert on text only the fixture's transcript can produce.
    //
    // All three provider badges too. This shot's job is to show that one list holds Claude, Codex
    // and OpenCode together; a fixture edit that quietly made them uniform again would otherwise
    // produce a perfectly valid-looking screenshot that no longer says the thing it is here to say.
    expect: `document.querySelectorAll('.rounded-2xl:not([data-slot="skeleton"])').length >= 3 && /empty postcode/.test(document.body.innerText) && ['Claude','Codex','OpenCode'].every((p) => [...document.querySelectorAll('aside [data-slot="badge"]')].some((b) => b.textContent.trim() === p))`,
  },
  {
    name: 'instances',
    viewport: [1060, 560],
    steps: [{ eval: clickIn('nav', 'Instances'), wait: 3500 }],
    // All three instance tables present, and both Claude account data and Codex isolation render.
    expect: `document.querySelectorAll('table').length === 3 && /Max 20/.test(document.body.innerText) && /CODEX_HOME/.test(document.body.innerText)`,
  },
  {
    name: 'analytics',
    viewport: [1180, 900],
    steps: [{ eval: clickIn('nav', 'Analytics'), wait: 3500 }],
    // The four headline tiles, at least three charts drawn, and the hour grid's full 168 cells.
    // Asserting on the CHARTS rather than on any text: the point of this shot is that the view
    // draws, and a fixture change that emptied the reports would otherwise photograph an empty
    // page with a perfectly correct heading on it.
    // The hour grid is asserted through its cells' ACCESSIBLE NAMES, not a `title` attribute: the
    // cells moved to a rich hover card and kept an aria-label, and this predicate catching that
    // change is exactly its job.
    expect: `/Cost by day/.test(document.body.innerText) && document.querySelectorAll('svg[role="img"]').length >= 2 && document.querySelectorAll('[aria-label*=":00, "]').length === 168`,
  },
  {
    name: 'queue',
    viewport: [1500, 840],
    // Over Sessions, not Instances: the drawer pushes the shell and clips the instances table's
    // Actions column.
    steps: [
      { eval: clickIn('nav', 'Sessions'), wait: 2200 },
      { eval: clickIn('header', 'Queue'), wait: 3000 },
    ],
    expect: `/Run queue/.test(document.body.innerText) && /Running/.test(document.body.innerText)`,
  },
];

// --- chrome discovery -------------------------------------------------------------------------
function findChrome() {
  // An override that points at nothing is a typo, not a hint to go looking elsewhere: silently
  // falling through to auto-discovery would shoot with a different browser than the one asked for.
  const envVar = process.env.CHROME_PATH ? 'CHROME_PATH' : process.env.PUPPETEER_EXECUTABLE_PATH ? 'PUPPETEER_EXECUTABLE_PATH' : null;
  const fromEnv = envVar ? process.env[envVar] : null;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`${envVar} points at nothing: ${fromEnv}`);
    return fromEnv;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) {
    throw new Error(
      'No Chrome/Chromium/Edge found. Set CHROME_PATH to a Chromium-based browser executable.',
    );
  }
  return hit;
}

async function waitForHttp(url, timeoutMs, abortedReason = () => null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (abortedReason()) return false;
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

// --- CDP --------------------------------------------------------------------------------------
/** Uncaught exceptions / console.error from the page, collected via CDP events (see cdp()). */
const pageErrors = [];

function cdp(ws) {
  let nextId = 1;
  const pending = new Map();
  /** Fail every in-flight call instead of leaving them pending forever if the socket dies. */
  const abortAll = (why) => {
    for (const [, p] of pending) p.reject(new Error(why));
    pending.clear();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`${m.error.message} (${m.method ?? 'cdp'})`));
      else resolve(m.result);
      return;
    }
    // CDP EVENTS carry no id. Without this branch an uncaught exception in the app was dropped on
    // the floor: `evaluate` only inspects exceptions from its own call, so the SPA could throw
    // during render and still be photographed looking half-built.
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      pageErrors.push(d?.exception?.description || d?.text || 'unknown page exception');
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      pageErrors.push(
        `console.error: ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? '?').join(' ')}`,
      );
    }
  };
  ws.onclose = () => abortAll('Chrome closed the DevTools connection');
  ws.onerror = () => abortAll('DevTools connection errored');

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      // Without a per-call deadline a wedged renderer hangs the whole command with no output.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after 60s`));
      }, 60_000);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      pending.set(id, { resolve: done(resolve), reject: done(reject) });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

/** Chrome writes the port it actually bound as the first line of DevToolsActivePort. */
async function readDevtoolsPort() {
  const file = join(PROFILE_DIR, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0].trim());
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* Chrome has not written it yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome never reported a DevTools port (did it fail to start?)');
}

async function pageTargetWs(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* devtools not listening yet */
    }
    await sleep(300);
  }
  throw new Error('Chrome never exposed a page target');
}

// --- main -------------------------------------------------------------------------------------
const procs = [];
/**
 * Kill a child AND its descendants.
 *
 * `child.kill()` is not enough for either process we spawn. `bun run --cwd web dev` is a wrapper
 * whose real work is a vite child, and Chrome forks helper processes; killing only the parent
 * leaves the dev server holding the port and the run never exits. That is not hypothetical — it
 * is exactly what the first version of this script did.
 */
const treeKill = (child) => {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Spawned detached below, so the child leads its own group and -pid takes the group with it.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    /* already gone */
  }
};
const killAll = () => {
  for (const p of procs.splice(0)) treeKill(p);
};
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(1); });

async function main() {
  mkdirSync(STAGE, { recursive: true });
  const stub = readFileSync(join(HERE, 'page-fixtures.js'), 'utf8');
  const chromePath = findChrome();
  // One fixed profile dir, wiped per run: timestamped dirs would pile up in tmp/ forever.
  rmSync(PROFILE_DIR, { recursive: true, force: true });

  let url = EXTERNAL_URL;
  if (!url) {
    console.log(`starting a private web server on :${PORT}`);
    const web = spawn(
      process.execPath,
      // --host 127.0.0.1 pins the bind: vite otherwise resolves "localhost" to ::1 on this machine,
      // and a client that resolves localhost to 127.0.0.1 first would poll a port nothing answers
      // on until the timeout. Pinning both sides to the same literal removes the ambiguity.
      ['run', '--cwd', 'web', 'dev', '--', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' },
    );
    procs.push(web);
    // Keep the tail of its output: if the server fails to bind (a stale process on the port is the
    // usual cause) the reason is in here, and swallowing it turns a clear error into a timeout.
    let serverLog = '';
    let serverDead = null;
    const note = (b) => {
      serverLog = (serverLog + b.toString()).slice(-2000);
    };
    web.stdout.on('data', note);
    web.stderr.on('data', note);
    // Fail fast: --strictPort exits immediately on EADDRINUSE, and without this the run would sit
    // out the full 60s poll before reporting a failure it already knew about.
    web.on('exit', (code) => {
      serverDead = `web server exited early (code ${code})`;
    });

    url = `http://127.0.0.1:${PORT}`;
    if (!(await waitForHttp(url, 60_000, () => serverDead))) {
      const why = serverDead ?? `web server never came up on :${PORT}`;
      throw new Error(`${why}\n--- server output ---\n${serverLog.trim() || '(no output)'}`);
    }
  }
  console.log(`shooting ${url}`);

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // Fresh profile every run (wiped just above): the app persists theme and collapse state to
      // localStorage, so a carried-over profile would silently change what the images show.
      `--user-data-dir=${PROFILE_DIR}`,
      // Port 0 = let the OS pick, then read it back from the profile. A derived fixed port meant
      // two concurrent runs collided: the second Chrome failed to bind, and the poller happily
      // attached to the FIRST run's browser instead — two scripts driving one tab, silently.
      '--remote-debugging-port=0',
      'about:blank',
    ],
    // detached on POSIX so treeKill's process-group kill reaches Chrome's helper processes too;
    // without it the group kill targets the wrong group and helpers survive the run.
    { stdio: 'ignore', detached: process.platform !== 'win32' },
  );
  procs.push(chrome);

  const ws = new WebSocket(await pageTargetWs(await readDevtoolsPort()));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not attach to Chrome'));
  });
  const send = cdp(ws);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
  await send('Page.navigate', { url });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text}`);
    return r?.result?.value;
  };

  /** Poll a page predicate instead of sleeping a guessed interval. */
  const waitFor = async (expression, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        /* context still swapping during load */
      }
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  // Wait for the app to actually mount rather than sleeping a fixed interval. A cold vite start
  // re-optimizes dependencies and can take well over the several seconds this used to assume,
  // which surfaced later and confusingly as "a setup step found nothing to click".
  await waitFor(`document.querySelectorAll('nav button').length >= 2`, 90_000, 'the app to mount');
  // Then let the first data pass settle so the list is populated, not skeletons.
  await waitFor(`document.querySelectorAll('aside button').length > 2`, 30_000, 'the session list');
  await sleep(800);

  // When a shot fails it is almost always because the app did not reach the state the step
  // assumed. Printing what the page actually showed turns "the UI moved" into something someone
  // can act on without re-running this by hand with a debugger attached.
  const pageSummary = async () => {
    try {
      return await evaluate(
        `JSON.stringify({url:location.href,title:document.title,buttons:document.querySelectorAll('button').length,tables:document.querySelectorAll('table').length,text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)})`,
      );
    } catch {
      return '<page unreachable>';
    }
  };

  for (const shot of SHOTS) {
    for (const step of shot.steps ?? []) {
      if ((await evaluate(step.eval)) === false) {
        throw new Error(
          `[${shot.name}] a setup step found nothing to click — the UI moved.\n  page: ${await pageSummary()}`,
        );
      }
      await sleep(step.wait ?? 2000);
    }
    await send('Emulation.setDeviceMetricsOverride', {
      width: shot.viewport[0],
      height: shot.viewport[1],
      deviceScaleFactor: SCALE,
      mobile: false,
    });
    await sleep(900);

    if (!(await evaluate(shot.expect))) {
      throw new Error(
        `[${shot.name}] the view did not render as expected — refusing to write a broken image.\n  expect: ${shot.expect}\n  page: ${await pageSummary()}`,
      );
    }

    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(STAGE, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    const bytes = statSync(file).size;
    if (bytes < MIN_PNG_BYTES) throw new Error(`[${shot.name}] wrote only ${bytes}B — almost certainly blank`);
    console.log(`  ${shot.name}.png  ${shot.viewport.join('x')}@${SCALE}x  ${(bytes / 1024).toFixed(0)}KB`);
  }

  // A page that threw while rendering is not a page worth photographing.
  if (pageErrors.length > 0) {
    const unique = [...new Set(pageErrors)].slice(0, 5);
    throw new Error(
      `the app reported ${pageErrors.length} error(s) while being captured:\n  ${unique.join('\n  ')}`,
    );
  }

  // The privacy guarantee, asserted rather than assumed: nothing may have reached a real API.
  const leaked = await evaluate('window.__fixtureEscapes ?? ["<stub never installed>"]');
  if (leaked.length > 0) {
    throw new Error(
      `${leaked.length} /api/ request(s) escaped the fixtures and could contain real data:\n  ${leaked.slice(0, 5).join('\n  ')}`,
    );
  }

  ws.close();

  // Only now, with the escape assertion passed, may the images reach the committed directory.
  if (KEEP) {
    console.log(`\nOK — ${SHOTS.length} shots kept in ${STAGE} (not installed)`);
  } else {
    mkdirSync(INSTALL_DIR, { recursive: true });
    for (const shot of SHOTS) {
      copyFileSync(join(STAGE, `${shot.name}.png`), join(INSTALL_DIR, `${shot.name}.png`));
    }
    console.log(`\nOK — ${SHOTS.length} shots installed into ${INSTALL_DIR}`);
  }
  console.log('every /api/ response was synthetic; no daemon ran and no real data was in scope');
}

main()
  .then(() => {
    killAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    killAll();
    process.exit(1);
  });

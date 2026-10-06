/** Lightweight execution of the pinned, unchanged first-party web modules.
 * Python owns authentication and network access. This process receives only
 * configuration and verification responses; it cannot send chat messages.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const assets = resolve(process.argv[2]);
const dependencies = resolve(process.argv[3]);
const origin = 'https://chatgpt.com';
const started = performance.now();
const requests = new Map();
let nextId = 0;
let finished = false;
let window;
let resolveConfig;
const configuration = new Promise(resolve => { resolveConfig = resolve; });
const input = createInterface({ input: process.stdin });
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
input.on('line', line => {
  try {
    const value = JSON.parse(line);
    if (value.type === 'config') resolveConfig(value);
    if (value.type === 'response' && requests.has(value.id)) {
      requests.get(value.id)(value);
      requests.delete(value.id);
    }
  } catch { finish('invalid_ipc'); }
});
function finish(error = null, headers = null) {
  if (finished) return;
  finished = true;
  const report = {
    browser_launched: false,
    seconds: Math.round((performance.now() - started) / 10) / 100,
    rss_mib_at_completion: Math.round(process.memoryUsage().rss / 10485.76) / 100,
  };
  try { window?.happyDOM.abort(); } catch {}
  // Wait until the token-bearing IPC record is flushed before closing the pipe.
  process.stdout.write(JSON.stringify({ type: 'result', error, report, headers }) + '\n',
    () => process.exit(error ? 1 : 0));
}
setTimeout(() => finish('runtime_timeout'), 40000);
process.on('uncaughtException', () => finish('runtime_error'));
process.on('unhandledRejection', () => {}); // The app's disabled telemetry is non-fatal.

async function main() {
  const config = await configuration;
  const profile = config.profile;
  const { Window } = await import(pathToFileURL(resolve(
    dependencies, 'node_modules', profile.runtime.package, profile.runtime.module)));
  window = new Window({ url: origin + '/', settings: {
    enableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true, disableCSSFileLoading: true,
    disableComputedStyleRendering: true, enableImageFileLoading: false,
    suppressInsecureJavaScriptEnvironmentWarning: true,
    navigator: { userAgent: config.user_agent },
    navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true,
      disableChildPageNavigation: true },
  } });
  window.document.write('<!doctype html><body></body>');
  Object.defineProperty(window, 'crypto', { value: webcrypto });
  Object.assign(window, { TextEncoder, TextDecoder, Request, Response, Headers });
  window.CLIENT_BOOTSTRAP = {
    ...config.bootstrap,
    // This is an opaque handle, not an auth token. Python replaces Authorization
    // at the HTTP boundary with the existing, verified account's real credential.
    session: { accessToken: 'AUTHENTICATED_BY_PYTHON_BRIDGE' }, user: null,
  };
  if (!/^[a-f0-9-]{36}$/i.test(config.device_id || '')) return finish('device_id_missing');
  window.document.cookie = `oai-did=${config.device_id}; Path=/; Secure; SameSite=Lax`;
  window.fetch = async (input, options = {}) => {
    const url = new URL(input?.url || String(input), origin);
    const method = options.method || input?.method;
    const body = options.body ?? (typeof input?.text === 'function' ? await input.text() : null);
    const paths = ['/backend-api/sentinel/chat-requirements/prepare',
      '/backend-api/sentinel/chat-requirements/finalize'];
    if (method !== 'POST' || url.origin !== origin || url.search || url.username || url.password
        || nextId >= 2 || url.pathname !== paths[nextId] || typeof body !== 'string') {
      throw new Error('Request outside preparation protocol');
    }
    const id = ++nextId;
    const response = new Promise(resolve => requests.set(id, resolve));
    write({ type: 'request', id, url: url.href, method, body });
    const reply = await response;
    return new window.Response(reply.body, { status: reply.status,
      headers: { 'Content-Type': 'application/json' } });
  };
  const entry = profile.entry;
  const names = new Set(Object.keys(profile.assets));
  const modules = new Map();
  const base = origin + '/cdn/assets/';
  function getModule(url) {
    if (modules.has(url)) return modules.get(url);
    const name = url.slice(base.length);
    if (!url.startsWith(base) || !names.has(name)) throw new Error('Unpinned module');
    const module = new vm.SourceTextModule(readFileSync(resolve(assets, name), 'utf8'), {
      context: window, identifier: url,
      initializeImportMeta: meta => { meta.url = url; },
      importModuleDynamically: async () => { throw new Error('Dynamic loading disabled'); },
    });
    modules.set(url, module);
    return module;
  }
  const module = getModule(base + entry);
  await module.link((name, parent) => getModule(new URL(name, parent.identifier).href));
  await module.evaluate({ timeout: 3000 });
  // Namespace exports are live bindings: initialization fills the providers.
  const app = Object.defineProperties({}, Object.fromEntries(Object.entries(profile.exports).map(
    ([name, exported]) => [name, { get: () => module.namespace[exported] }])));
  if (['initialize', 'prepare', 'finalize', 'observe', 'headers'].some(
    name => typeof app[name] !== 'function')) {
    return finish('runtime_protocol_changed');
  }
  app.initialize();
  if (['proof', 'turnstile'].some(
    name => typeof app[name]?.getEnforcementToken !== 'function')) {
    return finish('runtime_protocol_changed');
  }
  await app.prepare(true, 'conversation');
  const finalized = await app.finalize(false, 'conversation');
  if (typeof finalized?.token !== 'string' || !finalized.token) return finish('not_finalized');
  const proof = await app.proof.getEnforcementToken(finalized, { forceSync: true });
  const turnstile = await app.turnstile.getEnforcementToken(finalized);
  const observer = await app.observe(finalized);
  finish(null, app.headers(finalized, turnstile, proof, null, observer, '[1,null]'));
}
await main();

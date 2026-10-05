// The opt-in page half of the browser bridge (see browser-bridge.ts), served by the daemon at
// ROUTES.browserClient. A dev app adds ONE tag to its page:
//
//   <script src="http://localhost:4000/api/browser/client.js"></script>
//
// and its tabs then (1) buffer client-side runtime errors (window errors, failed resource loads,
// unhandled rejections, console.error), (2) answer the daemon's errors / metadata / tools / call
// requests, and (3) expose `window.__devwebui.register(name, { description, inputSchema, run })`
// so the app can publish its OWN inspection tools (component tree, element to source file:line,
// store state...) that agents call through DevWebUI's MCP. The page-registered-tool idea follows
// React DevTools' CDT MCP bridge (react/react, MIT); this is written fresh for DevWebUI.
//
// Kept as a plain ES5-ish string so the single-file binary carries it with no asset lookup, and
// so it runs unbundled in any page. No template literals inside it: this file wraps it in one.
export const BROWSER_CLIENT_JS = `(function () {
  "use strict";
  var api = window.__devwebui || (window.__devwebui = {});
  if (api.connected) return;
  var script = document.currentScript;
  var base = api.url || (script && script.src ? new URL(script.src).origin : "");
  if (!base) {
    console.warn("[devwebui] browser bridge: set window.__devwebui = { url: 'http://localhost:<daemon port>' } before loading the snippet from a module");
    return;
  }
  api.connected = true;
  var MAX_ERRORS = 50;
  var errors = [];
  var tools = api.tools || (api.tools = {});
  var tabId = null;

  function clip(v, n) { return v == null ? undefined : String(v).slice(0, n); }
  function record(kind, message, stack, source) {
    errors.push({ kind: kind, message: clip(message, 2000), stack: clip(stack, 4000), source: source, url: location.href, at: new Date().toISOString() });
    if (errors.length > MAX_ERRORS) errors.shift();
  }
  function fmt(v) {
    if (v instanceof Error) return v.stack || v.message;
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }

  // Capture phase so a failed <script>/<img>/<link> load (which does not bubble) is seen too.
  window.addEventListener("error", function (e) {
    if (e.target && e.target !== window && !(e instanceof ErrorEvent)) {
      var el = e.target;
      record("resource", "failed to load " + (el.src || el.href || el.tagName));
      return;
    }
    record("error", e.message, e.error && e.error.stack, e.filename ? e.filename + ":" + e.lineno + ":" + e.colno : undefined);
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    record("unhandledrejection", r && r.message ? r.message : fmt(r), r && r.stack);
  });
  var consoleError = console.error;
  console.error = function () {
    try { record("console.error", Array.prototype.map.call(arguments, fmt).join(" ")); } catch (_) {}
    return consoleError.apply(console, arguments);
  };

  function metadata() {
    var meta = {};
    document.querySelectorAll("meta[name], meta[property]").forEach(function (m) {
      meta[m.getAttribute("name") || m.getAttribute("property")] = m.getAttribute("content");
    });
    var nav = performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : null;
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      lang: document.documentElement.lang || undefined,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      meta: meta,
      timing: nav ? { domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd), loadMs: Math.round(nav.loadEventEnd) } : undefined,
      errorCount: errors.length,
      pageTools: Object.keys(tools),
      userAgent: navigator.userAgent
    };
  }
  function listTools() {
    return Object.keys(tools).map(function (name) {
      return { name: name, description: tools[name].description || "", inputSchema: tools[name].inputSchema || { type: "object" } };
    });
  }
  function handle(req) {
    if (req.kind === "errors") return errors.slice();
    if (req.kind === "metadata") return metadata();
    if (req.kind === "tools") return listTools();
    if (req.kind === "call") {
      var tool = tools[req.tool];
      if (!tool) throw new Error("this page registered no tool named " + req.tool);
      return tool.run(req.args || {});
    }
    throw new Error("unknown request kind " + req.kind);
  }
  function reply(req, body) {
    body.requestId = req.requestId;
    body.tabId = tabId;
    body.url = location.href;
    body.title = document.title;
    var text;
    try { text = JSON.stringify(body); } catch (e) {
      text = JSON.stringify({ requestId: req.requestId, tabId: tabId, url: location.href, title: document.title, error: "result is not JSON-serializable: " + e.message });
    }
    // text/plain keeps this a simple request (no CORS preflight).
    fetch(base + "/api/browser/reply", { method: "POST", headers: { "content-type": "text/plain" }, body: text }).catch(function () {});
  }

  // Page-registered tools. Returns an unregister function. A tool's run(args) may return a value
  // or a promise; a throw reaches the agent as { error }.
  api.register = function (name, def) {
    if (!name || !def || typeof def.run !== "function") throw new Error("register(name, { run }) needs a name and a run function");
    tools[name] = def;
    return function () { if (tools[name] === def) delete tools[name]; };
  };

  var source = new EventSource(base + "/api/browser/connect?url=" + encodeURIComponent(location.href) + "&title=" + encodeURIComponent(document.title));
  source.addEventListener("hello", function (e) { tabId = JSON.parse(e.data).tabId; });
  source.addEventListener("request", function (e) {
    var req = JSON.parse(e.data);
    Promise.resolve()
      .then(function () { return handle(req); })
      .then(function (result) { reply(req, { result: result }); }, function (err) { reply(req, { error: err && err.message ? err.message : String(err) }); });
  });
})();
`;

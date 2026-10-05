// A dependency-free stand-in for a real dev server, so the bundled example
// (extra.devwebui) has live processes to manage. Logs every 1.5s; optionally
// serves HTTP. Run from this folder:  node heartbeat.mjs <name> [port]
const name = process.argv[2] || "demo";
const port = Number(process.argv[3] || 0);
let n = 0;
let server = null;

console.log(`[${name}] starting up…`);

if (port) {
  const http = await import("node:http");
  server = http
    .createServer((_req, res) => res.end(`${name} ok\n`))
    .listen(port, () => console.log(`[${name}] listening on http://localhost:${port}`));
}

const ticker = setInterval(() => {
  console.log(`[${name}] tick ${++n} @ ${new Date().toLocaleTimeString()}`);
}, 1500);

process.on("SIGTERM", () => {
  console.log(`[${name}] shutting down`);
  clearInterval(ticker);
  server?.close();
  process.exit(0);
});

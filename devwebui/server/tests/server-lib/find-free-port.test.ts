// Tests for the shared free-port finder (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/find-free-port.test.ts, synced by sync.mjs into each app's
// `serverTests` dir, which is a `server-lib/` subdir next to the app's server tree). The
// `../../src/find-free-port.mjs` import resolves only from that synced location — sync.mjs
// validates the placement — so this file is NOT runnable inside the kit repo itself.
import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { findFreePort } from "../../src/find-free-port.mjs";

const open = new Set<Server>();

// Occupy the first free port at or above `base`, stepping past any in use, and return it. Used
// to establish a KNOWN-occupied port for the "steps over" tests. `base` is deliberately low
// (well under Windows' 49152–65535 ephemeral range) so there is ample headroom below 65535 —
// an OS-assigned ephemeral port could sit within `attempts` of the ceiling and make findFreePort
// legitimately run out of ports, which would make these tests flaky rather than meaningful.
//
// `host` MUST match the interface findFreePort will probe: omit it (wildcard) to collide with a
// default findFreePort(port) probe, or pass "127.0.0.1" to collide with findFreePort(port, _,
// "127.0.0.1"). On Windows a wildcard bind and a loopback bind on the same port do NOT conflict,
// so a mismatch would let findFreePort see the port as free and return it unchanged. The listener
// stays up until afterEach closes it.
function occupyAtOrAbove(base: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > 65535) {
        reject(new Error("test setup: no free port available to occupy"));
        return;
      }
      const server = createServer();
      server.once("error", () => {
        server.close();
        tryPort(port + 1); // port busy — step to the next
      });
      const onListening = () => {
        open.add(server);
        const addr: AddressInfo | string | null = server.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("could not read the bound port"));
      };
      if (host) server.listen(port, host, onListening);
      else server.listen(port, onListening);
    };
    tryPort(base);
  });
}

afterEach(async () => {
  await Promise.all([...open].map((s) => new Promise<void>((res) => s.close(() => res()))));
  open.clear();
});

test("steps over an occupied port and resolves a higher free one", async () => {
  const busy = await occupyAtOrAbove(34000);
  const found = await findFreePort(busy);
  expect(Number.isInteger(found)).toBe(true);
  expect(found).toBeGreaterThan(busy);
});

test("honours an explicit loopback host when probing", async () => {
  const busy = await occupyAtOrAbove(35000, "127.0.0.1");
  const found = await findFreePort(busy, 50, "127.0.0.1");
  expect(found).toBeGreaterThan(busy);
});

test("rejects with its own RangeError when the start port is past 65535", async () => {
  // The message is what proves the guard: listen(65536) throws a RangeError of its own, so the
  // type alone still passes with the guard removed.
  const err = await findFreePort(65536).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RangeError);
  expect((err as Error).message).toBe("findFreePort: no free port between 65536 and 65535");
});

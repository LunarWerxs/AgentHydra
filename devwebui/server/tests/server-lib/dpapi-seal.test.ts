// Tests for the shared DPAPI token-sealing lib (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/dpapi-seal.test.ts, synced by sync.mjs into each opting app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/dpapi-seal.mjs` import resolves only from that synced location — sync.mjs validates
// the placement — so this file is NOT runnable inside the kit repo itself.
//
// These pin the at-rest contract for the Connections refresh token: on Windows the token value is
// DPAPI-sealed (opaque, machine+user-bound); everywhere else it degrades to a documented plaintext
// passthrough. They also pin the CRITICAL upgrade path — a legacy plaintext token already on disk
// must keep working (no silent logout) and re-seal on the next write.
import { describe, expect, test } from "bun:test";
import { seal, unseal, wrapTokenStore, sealingActive } from "../../src/dpapi-seal.mjs";

const TOKEN_KEY = "cnx.connect.tokens.testclient";
const PKCE_KEY = "cnx.connect.pkce.testclient";
const TOKEN_JSON = JSON.stringify({ accessToken: "", refreshToken: "REFRESH-abc123", expiresAt: 0 });

// A plain in-memory ConnectStore to wrap (models each app's on-disk state.sdk map).
function memStore(seed?: Record<string, string>) {
  const backing = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    backing,
    store: {
      get: (k: string) => backing.get(k) ?? null,
      set: (k: string, v: string) => void backing.set(k, v),
      remove: (k: string) => void backing.delete(k),
    },
  };
}

describe("dpapi-seal", () => {
  test("seal → unseal round-trips the value", () => {
    expect(unseal(seal(TOKEN_JSON))).toBe(TOKEN_JSON);
  });

  test("seal encrypts at rest on Windows (opaque, marked, not the plaintext)", () => {
    const sealed = seal(TOKEN_JSON);
    if (sealingActive()) {
      expect(sealed).not.toBe(TOKEN_JSON);
      expect(sealed.startsWith("DPAPIv1:")).toBe(true);
      expect(sealed).not.toContain("REFRESH-abc123");
    } else {
      // Non-Windows / no bun:ffi: documented plaintext fallback (never a crash).
      expect(sealed).toBe(TOKEN_JSON);
    }
  });

  test("unseal treats a legacy plaintext value as-is (upgrade migration, no logout)", () => {
    // No DPAPIv1 marker → returned unchanged, so an already-signed-in daemon isn't logged out.
    expect(unseal(TOKEN_JSON)).toBe(TOKEN_JSON);
  });

  test("unseal returns null for an undecryptable DPAPIv1 blob (foreign machine/user)", () => {
    const result = unseal(`DPAPIv1:${Buffer.from("garbage-not-a-dpapi-blob").toString("base64")}`);
    expect(result).toBeNull();
  });

  test("wrapTokenStore seals the token key at rest but leaves other keys plaintext", () => {
    const { backing, store: inner } = memStore();
    const store = wrapTokenStore(inner, TOKEN_KEY);

    store.set(TOKEN_KEY, TOKEN_JSON);
    store.set(PKCE_KEY, "pkce-verifier-xyz");

    if (sealingActive()) {
      expect(backing.get(TOKEN_KEY)).not.toBe(TOKEN_JSON);
      expect(backing.get(TOKEN_KEY)!.startsWith("DPAPIv1:")).toBe(true);
    }
    // The transient PKCE record is never sealed.
    expect(backing.get(PKCE_KEY)).toBe("pkce-verifier-xyz");

    // Read back through the wrapper: both surface the original plaintext.
    expect(store.get(TOKEN_KEY)).toBe(TOKEN_JSON);
    expect(store.get(PKCE_KEY)).toBe("pkce-verifier-xyz");
  });

  test("wrapTokenStore migrates a legacy plaintext token on disk, then re-seals on write", () => {
    // Pre-upgrade state: the token sits in the backing store as plaintext.
    const { backing, store: inner } = memStore({ [TOKEN_KEY]: TOKEN_JSON });
    const store = wrapTokenStore(inner, TOKEN_KEY);

    // Reads the legacy plaintext without a logout.
    expect(store.get(TOKEN_KEY)).toBe(TOKEN_JSON);

    // A rotation write re-seals it at rest (on Windows).
    const rotated = JSON.stringify({ accessToken: "x", refreshToken: "REFRESH-def456", expiresAt: 1 });
    store.set(TOKEN_KEY, rotated);
    if (sealingActive()) {
      expect(backing.get(TOKEN_KEY)!.startsWith("DPAPIv1:")).toBe(true);
    }
    expect(store.get(TOKEN_KEY)).toBe(rotated);
  });

  test("wrapTokenStore.get returns null when the sealed token can't be decrypted", () => {
    const { store: inner } = memStore({ [TOKEN_KEY]: `DPAPIv1:${Buffer.from("nope").toString("base64")}` });
    const store = wrapTokenStore(inner, TOKEN_KEY);
    expect(store.get(TOKEN_KEY)).toBeNull();
  });
});

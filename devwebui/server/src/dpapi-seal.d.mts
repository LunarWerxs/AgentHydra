// Types for dpapi-seal.mjs (SHARED LunarWerx server-lib). Synced beside the .mjs by sync.mjs.

/** The @cnct/connect ConnectStore contract, re-declared here so the kit lib carries no
 *  dependency on the SDK's types. get/set/remove may each be sync or async. */
export interface ConnectStoreLike {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

/** True when seal() will DPAPI-encrypt (Windows + bun:ffi); false where it falls back to
 *  plaintext (non-Windows, or Node with no bun:ffi). */
export function sealingActive(): boolean;

/** Seal a plaintext string. `DPAPIv1:<base64>` on Windows/Bun; the input unchanged elsewhere. */
export function seal(plaintext: string): string;

/** Reverse seal(). Legacy plaintext (no DPAPIv1 marker) is returned as-is — the upgrade
 *  migration. An undecryptable DPAPIv1 blob (foreign machine/user, or corrupt) returns null. */
export function unseal(stored: string | null | undefined): string | null;

/** Wrap a ConnectStore so the value under `tokenKey` is DPAPI-sealed at rest; every other key
 *  passes through untouched. Returns a store of the same shape as `inner`. */
export function wrapTokenStore<S extends ConnectStoreLike>(inner: S, tokenKey: string): S;

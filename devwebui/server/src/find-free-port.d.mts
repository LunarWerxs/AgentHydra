/**
 * Find a bindable port at or above `preferred`. Walks upward, binding a throwaway
 * net.Server at each candidate (race-free), and resolves the first port that binds.
 * Rejects with a RangeError when `attempts` candidates (or port 65535) are exhausted,
 * or with the original error on an unexpected OS failure.
 */
export function findFreePort(preferred: number, attempts?: number, host?: string): Promise<number>;

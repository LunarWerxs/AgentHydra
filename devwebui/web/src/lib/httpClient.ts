/**
 * Shared HTTP client primitive for all LunarWerx app front-ends. One place that
 * does fetch + non-2xx handling, so each app's `api.ts` keeps only its endpoint
 * table (behind a thin local adapter that matches its historic call signature).
 *
 * `ApiError` carries the HTTP `status` plus a best-effort app `code` and the
 * parsed error `body`; the `message` is drawn defensively from the JSON body's
 * `message`/`error` field (the union of every app's server shape), falling back
 * to the status line.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;
  constructor(status: number, message: string, opts?: { code?: string; body?: unknown }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = opts?.code;
    this.body = opts?.body;
  }
}

/**
 * fetch + throw `ApiError` on any non-2xx (best-effort message/code from a JSON
 * error body), otherwise return the raw `Response` unread, use when the caller
 * wants the Response itself (e.g. a POST whose body it ignores).
 */
export async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const b = body as { message?: string; error?: string; code?: string } | undefined;
    const message = b?.message ?? b?.error ?? `${res.status} ${res.statusText}`.trim();
    throw new ApiError(res.status, message, { code: b?.code, body });
  }
  return res;
}

/**
 * fetch + throw on non-2xx + parse and return the JSON body (typed `T`). An
 * empty response body resolves to `undefined`.
 */
export async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await httpFetch(url, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

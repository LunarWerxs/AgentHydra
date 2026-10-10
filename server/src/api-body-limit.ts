import { bodyLimit } from 'hono/body-limit'

// climayte_run carries every worker prompt in one request (~40 sealed tasks of ~90 KB = ~3.6 MB, and
// callers want ~100), so the bound has to clear that; it still caps parser memory for local misuse.
export const API_BODY_LIMIT_BYTES = 16 * 1024 * 1024

export const apiBodyLimit = () =>
  bodyLimit({
    maxSize: API_BODY_LIMIT_BYTES,
    onError: (c) =>
      c.json(
        {
          error: `request body exceeds ${API_BODY_LIMIT_BYTES / (1024 * 1024)} MiB (the /api limit); split a large climayte_run tasks list into several calls`,
        },
        413,
      ),
  })

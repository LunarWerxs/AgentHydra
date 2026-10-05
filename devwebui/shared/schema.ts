// ---------------------------------------------------------------------------
// .devwebui file schema — the single source of truth for the on-disk format,
// shared so the daemon validates against the same shape the DTOs describe.
//
// This file imports `zod` (a server dependency). The WEB bundle must NEVER
// import this module at runtime — it only consumes the pure `import type` DTOs
// from dto.ts. Keep zod out of the web by never importing schema.ts from web.
// ---------------------------------------------------------------------------
import { z } from "zod";
import type { ProcessInput } from "./dto";

export const ID_RE = /^[a-zA-Z0-9._-]+$/;

export const ProcessSchema = z.object({
  id: z.string().min(1).regex(ID_RE, "id may only contain letters, numbers, . _ -"),
  name: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().optional(),
  color: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  autostart: z.boolean().optional(),
  starred: z.boolean().optional(),
  port: z.number().int().positive().optional(),
  url: z
    .string()
    // Reject any non-http(s) URI scheme (javascript:, data:, file:, …) so a stored
    // `url` can never become an XSS/redirect vector; an http(s):// URL or a plain
    // path (no scheme) is allowed.
    .refine((v) => /^https?:\/\//i.test(v) || !/^[a-z][a-z0-9+.-]*:/i.test(v), {
      message: "url must be an http(s):// URL or a path",
    })
    .optional(),
  runtime: z.enum(["node", "bun"]).optional(),
  // Dependency-ordered startup: wait for a port to be listening before spawning this
  // process. A number waits on that literal port; a string names a sibling process's
  // `id` (in this same file) and waits on THAT process's declared `port` — simpler than
  // a separate "depends on" field since "wait for the port" is the actual behavior.
  waitForPort: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  // Linked servers: sibling `id`s (in this same file) that start together with this
  // one. Links are symmetric and transitive — starting any member of a linked group
  // (via the single-process start action) starts the whole group. Unknown ids are
  // ignored at runtime (same leniency as a string `waitForPort`).
  links: z.array(z.string().min(1).regex(ID_RE)).optional(),
  // Companion: this process starts whenever any other process in the project is
  // started individually (GUI start button / MCP start_process) — e.g. a shared
  // database or proxy that everything needs but nobody wants to start by hand.
  companion: z.boolean().optional(),
  // Compose-managed dependencies (file-only, like `env`): before spawning, run
  // `docker compose up -d` for this stack, wait for its published ports, and inject
  // image-derived connection env (postgres gives DATABASE_URL). `file` is relative to
  // the .devwebui file; omitted, compose finds compose.yaml from the process's cwd.
  compose: z
    .object({
      file: z.string().min(1).optional(),
      mode: z.enum(["none", "start-only", "start-and-stop"]).optional(),
      skipIfRunning: z.boolean().optional(),
      readinessTimeoutMs: z.number().int().positive().optional(),
      services: z.array(z.string().min(1)).optional(),
      injectEnv: z.boolean().optional(),
    })
    .optional(),
  // Prompt answers: ordered expect/send rules typed into the process's stdin when its
  // output shows a prompt, for programs that read stdin without a TTY check (shell `read`,
  // `set /p`, Python input(), custom setup scripts) and would otherwise wait forever.
  // See server/src/prompt-answers.ts for the matching rules.
  answers: z
    .array(
      z.object({
        expect: z.string().min(1).optional(),
        send: z.string(),
        isRegex: z.boolean().optional(),
        optional: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const DevWebUIFileSchema = z.object({
  name: z.string().min(1),
  // Optional project accent color (a CSS color string; the GUI's picker writes `#rrggbb`).
  // Tints the project's stack icon in the panel header; unset falls back to the theme primary.
  color: z.string().optional(),
  processes: z.array(ProcessSchema).min(1),
});

export type DevWebUIProcess = z.infer<typeof ProcessSchema>;
export type DevWebUIFile = z.infer<typeof DevWebUIFileSchema>;

// Compile-time guard: the inferred schema type and the hand-written `ProcessInput`
// DTO must stay assignment-compatible, so the schema (SSOT) and the DTO can't
// drift. `env` is schema-only (the GUI doesn't edit it), which is why this is a
// one-directional `extends` check rather than a mutual equality.
type _SchemaMatchesProcessInput = DevWebUIProcess extends ProcessInput ? true : false;
const _check: _SchemaMatchesProcessInput = true;
void _check;

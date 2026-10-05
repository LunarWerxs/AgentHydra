// ───────────────────────────────────────────────────────────────────────────────
// The per-process `url` field is the title's click-through target. It must never
// be able to carry a dangerous URI scheme (javascript:, data:, file:, …) into a
// rendered link. The render helper (web/src/lib/format.ts) already only emits a
// value verbatim on an http(s):// match — but the SCHEMA is the real gate, so a
// `.devwebui` file (or a GUI edit) can't store such a value in the first place.
// These tests pin that boundary: http(s) URLs and plain paths in, schemes out.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import { DevWebUIFileSchema, ProcessSchema } from "../shared/schema";

const base = { id: "web", name: "Web", command: "bun run dev" };
const withUrl = (url: string) => ProcessSchema.safeParse({ ...base, url });

test("url accepts absolute http(s) URLs", () => {
  expect(withUrl("http://localhost:5173").success).toBe(true);
  expect(withUrl("https://app.example.com/admin").success).toBe(true);
  expect(withUrl("HTTPS://EXAMPLE.COM").success).toBe(true); // scheme is case-insensitive
});

test("url accepts plain paths (with or without a leading slash)", () => {
  expect(withUrl("/admin").success).toBe(true);
  expect(withUrl("admin").success).toBe(true);
  expect(withUrl("admin/dashboard").success).toBe(true);
  expect(withUrl("").success).toBe(true); // empty string is a no-op, not an error
});

test("url omitted entirely is valid (optional)", () => {
  expect(ProcessSchema.safeParse(base).success).toBe(true);
});

test("url rejects dangerous non-http(s) URI schemes", () => {
  expect(withUrl("javascript:alert(document.cookie)").success).toBe(false);
  expect(withUrl("data:text/html,<script>alert(1)</script>").success).toBe(false);
  expect(withUrl("file:///etc/passwd").success).toBe(false);
  expect(withUrl("vbscript:msgbox(1)").success).toBe(false);
  expect(withUrl("JavaScript:alert(1)").success).toBe(false); // scheme check is case-insensitive
});

test("ProcessSchema requires id, name, and command", () => {
  expect(ProcessSchema.safeParse({ id: "x", name: "X" }).success).toBe(false); // no command
  expect(ProcessSchema.safeParse({ id: "x", command: "c" }).success).toBe(false); // no name
});

test("ProcessSchema rejects ids with illegal characters", () => {
  expect(ProcessSchema.safeParse({ ...base, id: "has space" }).success).toBe(false);
  expect(ProcessSchema.safeParse({ ...base, id: "ok_id-1.2" }).success).toBe(true);
});

// The whole-file schema: a non-empty name plus at least one valid process.
const file = (over: Record<string, unknown> = {}) =>
  DevWebUIFileSchema.safeParse({ name: "App", processes: [base], ...over });

test("DevWebUIFileSchema accepts a name with at least one process", () => {
  expect(file().success).toBe(true);
});

test("DevWebUIFileSchema rejects an empty process list", () => {
  expect(file({ processes: [] }).success).toBe(false);
});

test("DevWebUIFileSchema rejects a missing or empty name", () => {
  expect(DevWebUIFileSchema.safeParse({ processes: [base] }).success).toBe(false);
  expect(file({ name: "" }).success).toBe(false);
});

test("DevWebUIFileSchema accepts an optional top-level color and round-trips it", () => {
  expect(file().success).toBe(true); // color omitted is valid
  expect(file({ color: "#ff8800" }).success).toBe(true);
  const parsed = DevWebUIFileSchema.parse({ name: "App", color: "#ff8800", processes: [base] });
  expect(parsed.color).toBe("#ff8800");
});

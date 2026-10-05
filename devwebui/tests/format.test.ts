// ───────────────────────────────────────────────────────────────────────────────
// Pure display helpers shared by the cards + table. processUrl is the click-through
// target builder for a process title — security-relevant, so its rules (absolute
// URLs pass through, everything else is anchored to a host) are pinned here.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import {
  formatAgo,
  formatAgoCoarse,
  formatBytes,
  formatDuration,
  formatUptime,
  processUrl,
} from "../web/src/lib/format";

test("processUrl uses an absolute http(s) url verbatim, ignoring host/port", () => {
  expect(processUrl(3000, "https://example.com/admin", "myhost")).toBe("https://example.com/admin");
  expect(processUrl(null, "http://example.com")).toBe("http://example.com");
});

test("processUrl appends a relative path to http://<host>:<port>", () => {
  expect(processUrl(5173, "/admin")).toBe("http://localhost:5173/admin");
  expect(processUrl(5173, "admin")).toBe("http://localhost:5173/admin"); // leading slash added
  expect(processUrl(5173, "/admin", "192.168.1.5")).toBe("http://192.168.1.5:5173/admin");
});

test("processUrl falls back to http://<host>:<port> when no url is given", () => {
  expect(processUrl(4000)).toBe("http://localhost:4000");
  expect(processUrl(4000, undefined, "devbox")).toBe("http://devbox:4000");
});

test("processUrl returns null when there's no port and no absolute url", () => {
  expect(processUrl(null)).toBeNull();
  expect(processUrl(undefined, "/admin")).toBeNull(); // a bare path has no host to hang off
});

test("formatDuration renders h/m/s at the right granularity", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(45)).toBe("45s");
  expect(formatDuration(65)).toBe("1m 5s");
  expect(formatDuration(3661)).toBe("1h 1m");
  expect(formatDuration(-10)).toBe("0s"); // negative is clamped
});

test("formatBytes switches KB→MB and shows — for empty", () => {
  expect(formatBytes(null)).toBe("—");
  expect(formatBytes(0)).toBe("—");
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
});

test("formatUptime is — unless the process is running with a start time", () => {
  const now = 1_000_000;
  expect(formatUptime(now, null, true)).toBe("—");
  expect(formatUptime(now, now - 5000, false)).toBe("—"); // not running
  expect(formatUptime(now, now - 65_000, true)).toBe("1m 5s");
});

test("formatAgo renders coarse relative time", () => {
  const now = 10_000_000;
  expect(formatAgo(now, now - 5_000)).toBe("5s ago");
  expect(formatAgo(now, now - 120_000)).toBe("2m ago");
  expect(formatAgo(now, now - 3 * 3_600_000)).toBe("3h ago");
});

test("formatAgoCoarse avoids second-by-second notification churn", () => {
  const now = 10_000_000;
  expect(formatAgoCoarse(now, now - 5_000)).toBe("just now");
  expect(formatAgoCoarse(now, now - 19_000)).toBe("10s ago");
  expect(formatAgoCoarse(now, now - 59_000)).toBe("50s ago");
  expect(formatAgoCoarse(now, now - 120_000)).toBe("2m ago");
});

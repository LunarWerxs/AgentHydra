import path from "node:path";
import { defineConfig } from "vitest/config";

// A separate config from vite.config.ts (not `mergeConfig`-ed onto it): the app's Vite config
// pulls in @tailwindcss/vite and a CSS-stripping plugin that only matter for a real build, and
// pulling those into every test run buys nothing but slower cold starts. The one thing that DOES
// need to match is the "@" alias — web/src/**/*.ts imports it everywhere.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    pool: "forks",
    maxWorkers: 4,
    environment: "jsdom",
  },
});

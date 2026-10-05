// ---------------------------------------------------------------------------
// Shared barrel — re-exports the pure DTOs, the route table, and the network
// constants. Deliberately does NOT re-export schema.ts (which imports zod) so a
// web import of this barrel never pulls zod into the browser bundle.
// ---------------------------------------------------------------------------
export * from "./dto";
export * from "./routes";
export * from "./constants";

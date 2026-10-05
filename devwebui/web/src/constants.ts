// The daemon's window-geometry constants are defined once in ../../shared/constants, which the
// daemon's own window code reads from the same file (server/src/constants.ts re-exports them
// there). Re-exported here so a module nested under src/lib/ reaches them with a one-level
// import instead of climbing out of web/ to the repo root.
export { WINDOW_SIZE_HINT_PARAM, parseWindowSizeHint } from "../../shared/constants";

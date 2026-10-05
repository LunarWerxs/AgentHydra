// Re-export the shared network, buffering and window-geometry constants so a module
// nested under src/<dir>/ reaches them as `../constants`. The canonical definitions
// live in ../../shared/constants.
export {
  DASHBOARD_WINDOW_SIZE,
  DEFAULT_DAEMON_PORT,
  FOCUS_PATH_PREFIX,
  FOCUS_WINDOW_SIZE,
  MAX_LOG_LINES,
  WINDOW_SIZE_HINT_PARAM,
  daemonPort,
  daemonUrl,
} from "../../shared/constants";

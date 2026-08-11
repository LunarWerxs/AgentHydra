//! The per-app config, a direct translation of `$TrayConfig` from Tray-Host.ps1.
//!
//! Same shape, same defaults, same names (camelCased), so a reader can hold the PowerShell header
//! comment and this file side by side. Everything app-specific lives here; the host itself stays
//! generic, which is the property that let one engine serve four apps and needs to survive.

use crate::json::{self, Json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StrayPolicy {
    /// Adopt a daemon that is already serving and host a tray for it (RepoYeti/DevWebUI/AgentHydra).
    Attach,
    /// Refuse: a live daemon with no tray is a headless orphan the user must stop (ReDesign).
    Warn,
}

#[derive(Debug, Clone, Copy)]
pub struct WindowSize {
    pub width: i32,
    pub height: i32,
}

pub struct Config {
    pub display_name: String,
    pub service_name: String,
    pub mutex_name: String,
    pub icon_file: PathBuf,
    pub app_root: PathBuf,
    pub script_dir: PathBuf,

    pub start_command: String,
    pub start_env: BTreeMap<String, String>,
    pub port_env_var: Option<String>,
    pub port: u16,
    pub url_host: String,
    pub info_file: PathBuf,

    /// Seconds to wait for a freshly-spawned daemon to bind. PowerShell default: 15.
    pub startup_wait_secs: u64,
    /// The same, for the restart/rebuild worker. PowerShell default: 12; AgentHydra pins 15.
    pub worker_wait_secs: u64,
    /// Extra restart attempts the worker makes when the daemon does not come back. ReDesign: 1.
    pub restart_retries: u32,
    /// Wait for the listen socket to actually free before re-spawning (force-kill apps).
    pub use_port_free_wait: bool,

    pub menu_open_label: String,
    pub rebuild_command: Option<String>,
    pub rebuild_log_name: String,
    /// "Rebuild & Restart" is dev-only: a distributed build ships no source to rebuild.
    pub is_dev_tree: bool,

    pub shutdown_token_env_var: Option<String>,
    pub shutdown_header_prefix: String,
    /// Dropped by the daemon when the user picks "Shut down" in the web UI: the tray must then tear
    /// the WHOLE app down rather than reviving it.
    pub sentinel_file: Option<PathBuf>,

    pub on_stray_daemon: StrayPolicy,
    /// When false the watchdog revives even a daemon this tray did not start. AgentHydra sets this
    /// to keep parity with its pre-kit launcher, which had no ownership gate at all.
    pub watchdog_requires_ownership: bool,

    pub portable_window_size: Option<WindowSize>,
    /// Additionally append `?window-size=WxH`, for apps whose web build applies it via resizeTo.
    pub portable_window_size_hint: bool,

    /// Optional EXTRA menu item that POSTs to the live daemon. For apps that supervise work the
    /// daemon owns (DevWebUI's managed dev servers) rather than just the daemon itself: Restart and
    /// Quit act on the daemon, this acts on what the daemon is running.
    pub action_path: Option<String>,
    pub action_label: String,
    pub action_ok_text: String,
    pub action_fail_text: String,
    pub action_timeout_secs: u64,

    /// Shown when the daemon starts but never serves. One app's overwhelmingly likely cause is a
    /// missing configuration step, and a tray icon that silently does nothing is a worse answer
    /// than telling the user which command to run.
    pub not_serving_hint: Option<String>,

    /// First-run bootstrap: `[{ "missing": "node_modules", "run": "bun install" }, ...]`. Each
    /// entry runs (blocking, once) only when its path is absent from the app root. The tray icon is
    /// already up by then, so a fresh checkout looks like it is working rather than hung.
    pub first_run: Vec<FirstRunStep>,
}

#[derive(Debug, Clone)]
pub struct FirstRunStep {
    pub missing: String,
    pub run: String,
}

fn opt_string(v: Option<&str>) -> Option<String> {
    v.map(str::to_string).filter(|s| !s.is_empty())
}

/// Expand `%VAR%`, `%VAR|fallback%` and a leading `~` in a config value.
///
/// This exists so ONE static config file serves both a dev checkout and an extracted release zip,
/// with no setup step to run first. The PowerShell adapter resolved these at launch in script; the
/// alternative here would be generating a config per machine, which is a step someone has to
/// remember and which silently goes stale.
pub fn expand(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    if let Some(tail) = rest.strip_prefix('~') {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            out.push_str(&home.to_string_lossy());
            rest = tail;
        }
    }
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = &after[..end];
        let (name, fallback) = match token.split_once('|') {
            Some((n, f)) => (n, f),
            None => (token, ""),
        };
        match std::env::var(name) {
            Ok(v) if !v.is_empty() => out.push_str(&v),
            // The fallback can itself need expanding (`~/.agenthydra`), so recurse.
            _ => out.push_str(&expand(fallback)),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

impl Config {
    pub fn load(path: &Path) -> Result<Config, String> {
        let src = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let v = json::parse(&src).ok_or_else(|| format!("{} is not valid JSON", path.display()))?;
        Config::from_json(&v, path)
    }

    fn from_json(v: &Json, path: &Path) -> Result<Config, String> {
        let need = |k: &str| -> Result<String, String> {
            v.str_at(k)
                .map(str::to_string)
                .ok_or_else(|| format!("{} is missing \"{k}\"", path.display()))
        };
        // The config sits in the app's misc/ dir, which is also where the icon and the launcher
        // live, so relative paths resolve against the CONFIG, never the cwd (a shortcut can be
        // launched with any working directory at all).
        let script_dir = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let raw_root = expand(&need("appRoot")?);
        let app_root = {
            let p = PathBuf::from(&raw_root);
            let joined = if p.is_absolute() {
                p
            } else {
                script_dir.join(p)
            };
            // `..` in the middle of a path confuses later `join`s and anything that logs it.
            joined.canonicalize().unwrap_or(joined)
        };

        // Compiled release vs source checkout, decided the way the adapter decided it: a compiled
        // exe sitting at the app root means run THAT, and the interpreter is not needed at all.
        let compiled = v
            .str_at("compiledExe")
            .map(|rel| app_root.join(expand(rel)))
            .filter(|p| p.exists());
        // Resolve the real interpreter rather than letting cmd.exe pick it off PATH: an `npm i -g
        // bun` install puts a .cmd shim ahead of the binary, and that shim re-launches through
        // another cmd layer (~245 ms against ~65 ms measured for the binary directly).
        let runtime = match v.get("runtimeCandidates") {
            Some(Json::Arr(items)) => items
                .iter()
                .filter_map(Json::as_str)
                .map(|c| PathBuf::from(expand(c)))
                .find(|p| p.exists())
                .map(|p| format!("\"{}\"", p.display())),
            _ => None,
        }
        .unwrap_or_else(|| v.str_at("runtimeFallback").unwrap_or("bun").to_string());

        let start_command = match &compiled {
            Some(exe) => v
                .str_at("startCommandCompiled")
                .unwrap_or("\"{COMPILED}\"")
                .replace("{COMPILED}", &exe.display().to_string()),
            None => need("startCommand")?.replace("{RUNTIME}", &runtime),
        };

        let size = v.get("portableWindowSize").and_then(|s| {
            let w = s.num_at("width")? as i32;
            let h = s.num_at("height")? as i32;
            // A malformed value degrades to "feature off", never to a junk --window-size.
            (w > 0 && h > 0).then_some(WindowSize {
                width: w,
                height: h,
            })
        });

        let mut start_env = BTreeMap::new();
        if let Some(Json::Obj(map)) = v.get("startEnv") {
            for (k, val) in map {
                if let Some(s) = val.as_str() {
                    start_env.insert(k.clone(), s.to_string());
                }
            }
        }

        Ok(Config {
            display_name: need("displayName")?,
            service_name: need("serviceName")?,
            // {ROOTHASH} = the first 16 uppercase hex chars of SHA-256 over the lowercased
            // resolved root, which is how one app gives a second checkout on the same machine its
            // own tray host instead of colliding on a fixed global name. Computed here so the name
            // matches the PowerShell host's byte for byte.
            mutex_name: {
                let raw = need("mutexName")?;
                if raw.contains("{ROOTHASH}") {
                    let id = app_root.to_string_lossy().to_lowercase();
                    // canonicalize() yields a \?\ extended-length prefix; PowerShell's
                    // Resolve-Path does not, and hashing the two would disagree.
                    let id = id.strip_prefix(r"\?\").unwrap_or(&id).to_string();
                    let hash = crate::sha256::hex(id.as_bytes())[..16].to_uppercase();
                    raw.replace("{ROOTHASH}", &hash)
                } else {
                    raw
                }
            },
            icon_file: script_dir.join(expand(v.str_at("iconFile").unwrap_or("app.ico"))),
            script_dir,
            start_command,
            start_env,
            port_env_var: opt_string(v.str_at("portEnvVar")).or_else(|| Some("PORT".into())),
            port: v.num_at("port").unwrap_or(0.0) as u16,
            url_host: v.str_at("urlHost").unwrap_or("127.0.0.1").to_string(),
            info_file: PathBuf::from(expand(&need("infoFile")?)),
            startup_wait_secs: v.num_at("startupWaitSec").unwrap_or(15.0) as u64,
            worker_wait_secs: v.num_at("workerWaitSec").unwrap_or(12.0) as u64,
            restart_retries: v.num_at("restartRetries").unwrap_or(0.0) as u32,
            use_port_free_wait: v.flag_at("usePortFreeWait"),
            menu_open_label: v
                .str_at("menuOpenLabel")
                .map(str::to_string)
                .unwrap_or_else(|| format!("Open {}", v.str_at("displayName").unwrap_or("app"))),
            rebuild_command: opt_string(v.str_at("rebuildCommand")),
            rebuild_log_name: v.str_at("rebuildLogName").unwrap_or("Rebuild.log").to_string(),
            // A STRING here is expanded first, so an app can gate the dev-only menu on an env
            // var ("%APP_DEV%") exactly as the PowerShell adapter did, rather than needing a
            // different config file for a dev checkout.
            is_dev_tree: match v.get("isDevTree") {
                Some(Json::Str(s)) => Json::Str(expand(s)).truthy(),
                Some(other) => other.truthy(),
                None => false,
            },
            shutdown_token_env_var: opt_string(v.str_at("shutdownTokenEnvVar")),
            shutdown_header_prefix: v.str_at("shutdownHeaderPrefix").unwrap_or("x-app").to_string(),
            sentinel_file: opt_string(v.str_at("sentinelFile")).map(|s| PathBuf::from(expand(&s))),
            on_stray_daemon: match v.str_at("onStrayDaemon") {
                Some("warn") => StrayPolicy::Warn,
                _ => StrayPolicy::Attach,
            },
            // Defaults to TRUE, matching the engine: an attached instance another session owns is
            // left alone unless the app opts out.
            watchdog_requires_ownership: v
                .get("watchdogRequiresOwnership")
                .map(Json::truthy)
                .unwrap_or(true),
            portable_window_size: size,
            portable_window_size_hint: v.flag_at("portableWindowSizeHint"),
            action_path: opt_string(v.str_at("actionPath")),
            action_label: v.str_at("actionLabel").unwrap_or("Run action").to_string(),
            action_ok_text: v.str_at("actionOkText").unwrap_or("Done.").to_string(),
            action_fail_text: v
                .str_at("actionFailText")
                .unwrap_or("{APP} didn't accept that. Open it to check.")
                .to_string(),
            action_timeout_secs: v.num_at("actionTimeoutSec").unwrap_or(60.0) as u64,
            not_serving_hint: opt_string(v.str_at("notServingHint")),
            // A COMPILED tree has no first run. The steps bootstrap a source checkout (`bun
            // install`, `bun run build`); a release bundle ships the built artifacts and no
            // interpreter, so every step's `missing` path is absent there and all of them would
            // fire — spawning bun commands that can only fail, on the one layout guaranteed not to
            // have bun. The PowerShell adapters gated this per app (`FirstRun = if
            // ($isCompiledTree) { $null }`); the JSON config has no place to express that, so the
            // gate belongs here, where the compiled exe was just resolved.
            first_run: match v.get("firstRun").filter(|_| compiled.is_none()) {
                Some(Json::Arr(items)) => items
                    .iter()
                    .filter_map(|it| {
                        Some(FirstRunStep {
                            missing: it.str_at("missing")?.to_string(),
                            run: it.str_at("run")?.to_string(),
                        })
                    })
                    .collect(),
                _ => Vec::new(),
            },
            app_root,
        })
    }

    /// `{PORT}` / `{TOKEN}` substitution, computed once and reused by cold start, the worker and
    /// the watchdog, so every launch path is byte-identical.
    pub fn resolved_start_command(&self, token: &str) -> String {
        self.start_command
            .replace("{PORT}", &self.port.to_string())
            .replace("{TOKEN}", token)
    }

    pub fn resolved_start_env(&self, token: &str) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for (k, v) in &self.start_env {
            out.insert(
                k.clone(),
                v.replace("{PORT}", &self.port.to_string())
                    .replace("{TOKEN}", token),
            );
        }
        if let Some(port_var) = &self.port_env_var {
            out.insert(port_var.clone(), self.port.to_string());
        }
        if let Some(token_var) = &self.shutdown_token_env_var {
            out.insert(token_var.clone(), token.to_string());
        }
        out
    }

    pub fn shutdown_header(&self, suffix: &str) -> String {
        format!("{}-{suffix}", self.shutdown_header_prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config whose `appRoot` is this crate dir, so `compiledExe` can point at a file that really
    /// exists (the resolver filters on `.exists()`) without any temp-file dance.
    fn config_with(compiled_exe: &str) -> Config {
        let crate_dir = env!("CARGO_MANIFEST_DIR");
        let src = format!(
            r#"{{
                "displayName": "Test", "serviceName": "test", "mutexName": "TestTray",
                "appRoot": "{}", "infoFile": "runtime.json",
                "startCommand": "{{RUNTIME}} server/src/index.ts",
                "compiledExe": "{compiled_exe}",
                "firstRun": [
                    {{ "missing": "node_modules", "run": "bun install" }},
                    {{ "missing": "web\\dist", "run": "bun run build" }}
                ]
            }}"#,
            crate_dir.replace('\\', "\\\\")
        );
        let v = json::parse(&src).expect("valid json");
        Config::from_json(&v, Path::new("test-tray.json")).expect("valid config")
    }

    #[test]
    fn a_source_checkout_keeps_its_first_run_steps() {
        // No compiled exe at the root ⇒ this is a checkout, and bootstrapping is exactly right.
        let cfg = config_with("definitely-not-here.exe");
        assert_eq!(cfg.first_run.len(), 2);
    }

    #[test]
    fn a_compiled_release_has_no_first_run() {
        // The release layout ships built artifacts and NO interpreter, so every `missing` path is
        // absent and every step would fire `bun ...` on the one tree guaranteed to lack bun.
        let cfg = config_with("Cargo.toml");
        assert!(
            cfg.first_run.is_empty(),
            "a compiled tree must not bootstrap: {:?}",
            cfg.first_run
        );
    }
}

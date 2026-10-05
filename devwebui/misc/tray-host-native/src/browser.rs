//! Opening the app's UI, including the portable (chromeless `--app`) window path.
//!
//! The sizing rules are ported verbatim from Tray-Host.ps1's Open-AppUi / Get-RememberedPlacement,
//! which are themselves a port of the daemon's own probe, so a cold tray start and the daemon's
//! `POST /api/portable-window` make the SAME decision. Diverging here means a window that jumps
//! size depending on which path opened it.

use crate::config::Config;
use crate::json::Json;
use crate::win::{shell_open, shell_open_with};
use std::path::{Path, PathBuf};

pub struct Placement {
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
}

/// Chromium's own GenerateApplicationNameFromURL key: hostname + "_" + path.
///
/// The PORT and the QUERY STRING are both absent from it (Chromium's omissions, not ours; verified
/// on Edge 150), which is what lets us probe with the plain URL and launch with a
/// `?window-size`-tagged one and still land on the SAME saved slot.
fn placement_key(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let host = authority.split(':').next()?;
    let path = path.split('?').next().unwrap_or("/");
    Some(format!("{host}_{path}"))
}

/// The placement Chromium has saved for this window, or None when nothing usable is stored.
///
/// Two subtleties carried over, both verified on Edge 150:
///
/// * Chromium writes prefs BY DOTTED PATH, so a key containing dots (any URL path with a dot in it)
///   lands as NESTED dicts rather than under the flat key its own naming produces. Probe flat
///   first, then walk the key as a dotted path, requiring an object at every hop so a sibling
///   window's key that merely shares this one as a prefix cannot read as "this window was saved".
/// * `maximized: true` means the rect holds the pre-maximize RESTORE bounds, not the live size, so
///   the caller must not use it as a size hint.
///
/// A rect under 50 px a side is junk (zero-area rects, monitor-reconciliation leftovers), not a
/// remembered size; Chromium's own drag-resize minimum sits well above it.
pub fn remembered_placement(profile_dir: &Path, url: &str) -> Option<Placement> {
    let key = placement_key(url)?;
    let prefs = std::fs::read_to_string(profile_dir.join("Default").join("Preferences")).ok()?;
    let root = crate::json::parse(&prefs)?;
    let placements = root.get("browser")?.get("app_window_placement")?;

    let node = match placements.get(&key) {
        Some(n) => n,
        None => {
            let mut cursor = placements;
            for segment in key.split('.') {
                if !matches!(cursor, Json::Obj(_)) {
                    return None;
                }
                cursor = cursor.get(segment)?;
            }
            cursor
        }
    };
    if !matches!(node, Json::Obj(_)) {
        return None;
    }

    // All four edges must be present AND numeric. A missing/string/bool edge is not a rect.
    let left = node.num_at("left")?;
    let top = node.num_at("top")?;
    let right = node.num_at("right")?;
    let bottom = node.num_at("bottom")?;
    let width = (right - left) as i32;
    let height = (bottom - top) as i32;
    if width < 50 || height < 50 {
        return None;
    }
    Some(Placement {
        width,
        height,
        maximized: node.flag_at("maximized"),
    })
}

fn chromium_browser() -> Option<PathBuf> {
    let pf86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    let pf = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = &pf86 {
        candidates.push(p.join(r"Microsoft\Edge\Application\msedge.exe"));
    }
    if let Some(p) = &pf {
        candidates.push(p.join(r"Microsoft\Edge\Application\msedge.exe"));
        candidates.push(p.join(r"Google\Chrome\Application\chrome.exe"));
    }
    if let Some(p) = &pf86 {
        candidates.push(p.join(r"Google\Chrome\Application\chrome.exe"));
    }
    if let Some(p) = &local {
        candidates.push(p.join(r"Google\Chrome\Application\chrome.exe"));
    }
    candidates.into_iter().find(|c| c.exists())
}

/// Is portable mode on? Re-read FRESH from the runtime pointer every call, so a setting flipped in
/// the web UI after this tray started is honoured on the next open.
fn portable_mode(cfg: &Config) -> bool {
    std::fs::read_to_string(&cfg.info_file)
        .ok()
        .and_then(|s| crate::json::parse(&s))
        .map(|v| v.flag_at("portableMode"))
        .unwrap_or(false)
}

/// Open the app UI at `url`. Never fails loudly: worst case it falls back to a normal browser tab
/// rather than opening nothing.
pub fn open_ui(cfg: &Config, url: &str) {
    if !portable_mode(cfg) {
        shell_open(url);
        return;
    }
    let Some(browser) = chromium_browser() else {
        shell_open(url);
        return;
    };

    // Dedicated profile beside runtime.json, so the app window remembers its own geometry instead
    // of fighting over the default profile. Same convention the daemon's own open path uses.
    let profile_dir = cfg
        .info_file
        .parent()
        .unwrap_or(Path::new("."))
        .join("portable-profile");
    let mut args: Vec<String> = Vec::new();
    if std::fs::create_dir_all(&profile_dir).is_ok() {
        args.push(format!("--user-data-dir={}", profile_dir.display()));
        args.push("--no-first-run".into());
        args.push("--no-default-browser-check".into());
    }

    let mut target = url.to_string();
    if let Some(size) = cfg.portable_window_size {
        let placement = remembered_placement(&profile_dir, url);
        // --window-size ONLY while the profile remembers nothing usable for this slot. A placement
        // the user made by resizing (or maximizing, where the rect holds restore bounds and the
        // window reopens maximized natively) has to win on every later launch, and --window-size
        // would override it every time.
        if placement.is_none() {
            args.push(format!("--window-size={},{}", size.width, size.height));
        }
        if cfg.portable_window_size_hint {
            let hint = match &placement {
                None => Some((size.width, size.height)),
                Some(p) if !p.maximized => Some((p.width, p.height)),
                // Never hint a maximized window: the page's resizeTo would visibly un-maximize it.
                Some(_) => None,
            };
            if let Some((w, h)) = hint {
                let sep = if target.contains('?') { '&' } else { '?' };
                target = format!("{target}{sep}window-size={w}x{h}");
            }
        }
    }
    args.push(format!("--app={target}"));
    shell_open_with(&browser, &args);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_prefs(dir: &Path, body: &str) {
        let d = dir.join("Default");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("Preferences"), body).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("lwtray-test-{name}"));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn key_drops_the_port_and_the_query() {
        // Both omissions are Chromium's, and they are what let us probe with the plain URL and
        // launch with a ?window-size-tagged one and still hit the same saved slot.
        assert_eq!(
            placement_key("http://127.0.0.1:7787/").as_deref(),
            Some("127.0.0.1_/")
        );
        assert_eq!(
            placement_key("http://127.0.0.1:7787/?window-size=1060x800").as_deref(),
            Some("127.0.0.1_/")
        );
        assert_eq!(
            placement_key("http://127.0.0.1:9999/instances").as_deref(),
            Some("127.0.0.1_/instances")
        );
    }

    #[test]
    fn reads_a_flat_placement() {
        let dir = scratch("flat");
        write_prefs(
            &dir,
            r#"{"browser":{"app_window_placement":{"127.0.0.1_/":
               {"left":10,"top":20,"right":1070,"bottom":820,"maximized":false}}}}"#,
        );
        let p = remembered_placement(&dir, "http://127.0.0.1:7787/").expect("found");
        assert_eq!((p.width, p.height, p.maximized), (1060, 800, false));
    }

    #[test]
    fn walks_a_dotted_key_as_nested_dicts() {
        // Chromium writes prefs BY DOTTED PATH, so a key containing a dot lands nested rather than
        // under the flat key its own naming produces.
        let dir = scratch("dotted");
        write_prefs(
            &dir,
            r#"{"browser":{"app_window_placement":{"127":{"0":{"0":{"1_/":
               {"left":0,"top":0,"right":900,"bottom":700,"maximized":true}}}}}}}"#,
        );
        let p = remembered_placement(&dir, "http://127.0.0.1:7787/").expect("found");
        assert_eq!((p.width, p.height, p.maximized), (900, 700, true));
    }

    #[test]
    fn rejects_junk_rects_and_missing_edges() {
        let dir = scratch("junk");
        // Under the 50px floor a side: a zero-area or monitor-reconciliation leftover, not a size.
        write_prefs(
            &dir,
            r#"{"browser":{"app_window_placement":{"127.0.0.1_/":
               {"left":0,"top":0,"right":40,"bottom":800}}}}"#,
        );
        assert!(remembered_placement(&dir, "http://127.0.0.1:7787/").is_none());

        // A non-numeric edge is not a rect.
        write_prefs(
            &dir,
            r#"{"browser":{"app_window_placement":{"127.0.0.1_/":
               {"left":"0","top":0,"right":1070,"bottom":820}}}}"#,
        );
        assert!(remembered_placement(&dir, "http://127.0.0.1:7787/").is_none());

        // A missing edge is not a rect.
        write_prefs(
            &dir,
            r#"{"browser":{"app_window_placement":{"127.0.0.1_/":{"left":0,"top":0,"right":1070}}}}"#,
        );
        assert!(remembered_placement(&dir, "http://127.0.0.1:7787/").is_none());
    }

    #[test]
    fn a_prefix_sharing_sibling_does_not_count_as_this_window() {
        // The dotted walk requires an object at every hop, so a sibling whose key merely SHARES
        // this key as a prefix must not read as "this window was saved".
        let dir = scratch("sibling");
        write_prefs(
            &dir,
            r#"{"browser":{"app_window_placement":{"127":{"0":{"0":{"1_":
               {"left":0,"top":0,"right":900,"bottom":700}}}}}}}"#,
        );
        assert!(remembered_placement(&dir, "http://127.0.0.1:7787/").is_none());
    }

    #[test]
    fn a_fresh_or_unreadable_profile_is_simply_unremembered() {
        let dir = scratch("fresh");
        assert!(remembered_placement(&dir, "http://127.0.0.1:7787/").is_none());
        write_prefs(&dir, "not json at all");
        assert!(remembered_placement(&dir, "http://127.0.0.1:7787/").is_none());
    }
}

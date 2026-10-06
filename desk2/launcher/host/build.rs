// AgentHydra's own icon (misc/AgentHydra.ico, made by misc/Make-Icon.ps1), compiled into HydraDesk2.exe as
// icon 1 (owner, 2026-10-06: "We need to be using the OG Agent Hydra icon"): Explorer, Task Manager, a
// pinned taskbar button, the shortcuts (install-shortcuts.ps1 points them here) and the window itself
// (main.rs set_icon) all take it from the exe. Task Manager lists the process by its FileDescription.
fn main() {
    let host =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let ico = host
        .join("..")
        .join("..")
        .join("..")
        .join("misc")
        .join("AgentHydra.ico");
    println!("cargo:rerun-if-changed={}", ico.display());
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        winresource::WindowsResource::new()
            .set_icon(ico.to_str().expect("icon path"))
            .set("FileDescription", "AgentHydra")
            .set("ProductName", "AgentHydra")
            .compile()
            .expect("compile the icon resource (needs the Windows SDK's rc.exe)");
    }
}

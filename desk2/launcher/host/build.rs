// AgentHydra's own icon (misc/AgentHydra.ico, made by misc/Make-Icon.ps1), compiled into HydraDesk2.exe as
// icon 1 (owner, 2026-10-06: "We need to be using the OG Agent Hydra icon"): Explorer, Task Manager, a
// pinned taskbar button, the shortcuts (install-shortcuts.ps1 points them here) and the window itself
// (main.rs set_icon) all take it from the exe. Task Manager lists the process by its FileDescription.
// The manifest says the exe is written for Windows 10 and 11: without it Windows refuses a layered child window, which
// the caption sink over the page's window buttons is (main.rs win::caption_sink, Windows 11's snap layouts).
const MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
</assembly>"#;

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
            .set_manifest(MANIFEST)
            .compile()
            .expect("compile the icon resource (needs the Windows SDK's rc.exe)");
    }
}

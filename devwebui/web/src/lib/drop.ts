// Pure drag-and-drop path/name extraction for the Add Project dialog. No Vue
// reactivity here — given a DataTransfer or a dropped file-system entry, recover a
// real OS path or a project name. Kept out of the component so the dialog stays
// focused on its flow and these stay independently testable.

/** Recover a real path from the OS drag payload (works in Firefox / dragged text/paths). */
export function pathFromDrop(dt: DataTransfer): string | null {
  for (const type of ["text/uri-list", "text/x-moz-url", "text/plain"]) {
    let raw = dt.getData(type);
    if (!raw) continue;
    raw = raw.split("\n")[0]?.trim() ?? "";
    if (!raw || raw.startsWith("#")) continue;
    if (/^file:\/\//i.test(raw)) {
      try {
        // file:///D:/a%20b -> D:/a b ; file:///home/u -> /home/u
        return decodeURIComponent(new URL(raw).pathname).replace(/^\/([A-Za-z]:)/, "$1");
      } catch {
        return raw;
      }
    }
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return raw;
  }
  return null;
}

/** Read a dropped .devwebui File and pull out its project name (for the prompt). */
export function projectNameFromFile(f?: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (!f) return resolve(null);
    const r = new FileReader();
    r.onload = () => {
      try {
        resolve(JSON.parse(String(r.result)).name ?? null);
      } catch {
        resolve(null);
      }
    };
    r.onerror = () => resolve(null);
    r.readAsText(f);
  });
}

/** Look inside a dropped folder for a .devwebui file and read its project name. */
export async function findProjectNameInDir(dir: FileSystemDirectoryEntry): Promise<string | null> {
  const entries = await readAllEntries(dir.createReader());
  const hit = entries.find((en) => en.isFile && en.name.toLowerCase().endsWith(".devwebui")) as
    | FileSystemFileEntry
    | undefined;
  if (!hit) return null;
  const file = await new Promise<File | null>((res) =>
    hit.file(
      (f) => res(f),
      () => res(null),
    ),
  );
  return projectNameFromFile(file ?? undefined);
}

/** readEntries() yields at most 100 entries per call — loop until it's drained. */
export function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

import fs from "node:fs/promises";
import path from "node:path";

export async function writeReport(outputPath, report) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, report, "utf8");
}

export async function removeReport(outputPath) {
  try {
    await fs.unlink(outputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

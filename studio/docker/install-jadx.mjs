import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { JADX_RELEASE } from "../../dist/android/JadxRelease.js";

const response = await fetch(JADX_RELEASE.url, {
  signal: AbortSignal.timeout(180_000),
});
if (!response.ok)
  throw new Error(`JADX download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== JADX_RELEASE.sha256) {
  throw new Error("JADX checksum mismatch; refusing to install.");
}
await writeFile("/opt/reall/providers/jadx.jar", bytes);

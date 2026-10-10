import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import fixture from "./vhome.json" with { type: "json" };

const args = process.argv.slice(2);
if (args.length > 1)
  throw new Error("Usage: npm run fixtures:harmony -- [DIRECTORY]");
const directory = resolve(
  args[0] ??
    fileURLToPath(
      new URL("../../../_reference/harmony-integration/", import.meta.url),
    ),
);
await mkdir(directory, { recursive: true });
const hashFile = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const path = join(directory, fixture.filename);
try {
  const digest = await hashFile(path);
  if (digest !== fixture.sha256)
    throw new Error(
      `Existing ${path} has a different SHA-256; it was not overwritten`,
    );
  console.log(`Verified existing ${path}: ${digest}`);
} catch (cause) {
  if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
    throw cause;
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    const response = await fetch(fixture.url, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || response.body === null)
      throw new Error(
        `Download failed: ${fixture.url}: HTTP ${response.status}`,
      );
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
    } finally {
      await handle.close();
    }
    const digest = hash.digest("hex");
    if (digest !== fixture.sha256)
      throw new Error(
        `SHA-256 mismatch for ${fixture.filename}: expected ${fixture.sha256}, received ${digest}`,
      );
    await link(temporary, path);
    console.log(`Downloaded and verified ${path}: ${digest}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

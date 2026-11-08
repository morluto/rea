import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { JADX_RELEASE } from "../../../src/android/JadxRelease.ts";
import fixture from "./apidemos.json" with { type: "json" };

const args = process.argv.slice(2);
if (args.length > 1)
  throw new Error("Usage: npm run fixtures:android -- [DIRECTORY]");
const directory = resolve(
  args[0] ??
    fileURLToPath(
      new URL("../../../_reference/apk-integration/", import.meta.url),
    ),
);
await mkdir(directory, { recursive: true });
const hashFile = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const fetchFixture = async (url) => {
  const maxAttempts = 3;
  // Retries share the existing deadline rather than extending the CI budget.
  const signal = AbortSignal.timeout(120_000);
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/octet-stream" },
    });
    if (
      ![429, 502, 503, 504].includes(response.status) ||
      attempt === maxAttempts
    )
      return response;
    await response.body?.cancel();
    console.warn(
      `Download returned HTTP ${response.status}; retrying ${url} (${attempt}/${maxAttempts - 1})`,
    );
    await delay(attempt * 1000, undefined, { signal });
  }
};
for (const item of [
  {
    url: JADX_RELEASE.url,
    sha256: JADX_RELEASE.sha256,
    filename: "jadx-headless-mcp-0.7.1-all.jar",
  },
  fixture,
]) {
  const path = join(directory, item.filename);
  try {
    const digest = await hashFile(path);
    if (digest !== item.sha256)
      throw new Error(
        `Existing ${path} has a different SHA-256; it was not overwritten`,
      );
    console.log(`Verified existing ${path}: ${digest}`);
    continue;
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      throw cause;
  }
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    const response = await fetchFixture(item.url);
    if (!response.ok || response.body === null)
      throw new Error(`Download failed: ${item.url}: HTTP ${response.status}`);
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
    if (digest !== item.sha256)
      throw new Error(
        `SHA-256 mismatch for ${item.filename}: expected ${item.sha256}, received ${digest}`,
      );
    await link(temporary, path);
    console.log(`Downloaded and verified ${path}: ${digest}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

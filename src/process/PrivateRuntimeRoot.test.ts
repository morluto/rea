import { access, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { PrivateRuntimeRoot } from "./PrivateRuntimeRoot.js";

const retained: string[] = [];
afterEach(async () => {
  for (const path of retained.splice(0))
    await rm(path, { recursive: true, force: true });
});

it("keeps the POSIX directory after keepFiles and does not delete it on a later close", async () => {
  const root = await PrivateRuntimeRoot.create({
    parent: tmpdir(),
    prefix: "rea-runtime-keep-",
  });
  retained.push(root.path);
  const marker = join(root.path, "kept");
  await writeFile(marker, "retained");
  await root.keepFiles();
  await access(marker);
  await root.close();
  await access(marker);
});

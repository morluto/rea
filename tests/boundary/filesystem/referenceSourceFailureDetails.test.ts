import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { importReferenceSource } from "../../../src/application/ReferenceSourceImport.js";
import { readReferenceSource } from "../../../src/reference/ReferenceSourceReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const importTree = (root: string) =>
  importReferenceSource({
    root,
    caller: "native-entry-failure-detail-test",
    policy: { secretPatterns: [] },
  });

const permissionChecksUnavailable =
  process.platform === "win32" || process.getuid?.() === 0;

describe("reference import native entry failure details", () => {
  it.skipIf(permissionChecksUnavailable)(
    "retains the actual operating-system reason for an unreadable file",
    async () => {
      const root = await createTestTempDirectory("rea-import-native-detail-");
      const path = join(root, "blocked.ts");
      await writeFile(path, "export const value = 1;\n");
      await chmod(path, 0);
      try {
        const read = await readReferenceSource(root);
        if (!read.ok) throw new Error(read.error.message);
        const failure = read.value.entries.find(
          (entry) => entry.status === "failed" && entry.path === "blocked.ts",
        );
        if (failure?.status !== "failed")
          throw new Error(
            "Owned permission fixture did not produce a read failure",
          );
        expect(failure.message).toContain("EACCES");
        const imported = await importTree(root);
        if (!imported.ok) throw new Error(imported.error.message);
        const entry = imported.value.entries.find(
          (item) => item.path === failure.path,
        );
        expect(entry?.limitations.join(" ")).toContain(failure.message);
      } finally {
        await chmod(path, 0o600);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains the unsupported file-type reason without suggesting another OS",
    async () => {
      const root = await createTestTempDirectory("rea-import-native-fifo-");
      await promisify(execFile)("mkfifo", [join(root, "events.pipe")], {
        timeout: 2_000,
      });
      const imported = await importTree(root);
      if (!imported.ok) throw new Error(imported.error.message);
      const entry = imported.value.entries.find(
        (item) => item.path === "events.pipe",
      );
      expect(entry?.limitations.join(" ")).toContain(
        "Entry is not a regular file",
      );
      expect(entry?.limitations.join(" ")).not.toContain("supported system");
    },
  );

  it("preserves an ordinary readable source-file control", async () => {
    const root = await createTestTempDirectory("rea-import-native-readable-");
    await writeFile(join(root, "main.ts"), "export const value = 1;\n");
    const imported = await importTree(root);
    if (!imported.ok) throw new Error(imported.error.message);
    expect(
      imported.value.entries.find(({ path }) => path === "main.ts"),
    ).toMatchObject({ kind: "file", content_state: "hashed", limitations: [] });
  });
});

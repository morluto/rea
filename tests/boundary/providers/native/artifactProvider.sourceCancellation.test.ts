/**
 * Given a real ASAR member stream and destination preparation in progress:
 * - cancellation returns its original cause, closes the stream, and rolls back;
 * - a denied rollback retains its owner until same-client cleanup/retry succeeds;
 * - without cancellation, extraction publishes the original bytes.
 */
import { createPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { SafeOutputTree } from "../../../../src/artifacts/SafeOutputTree.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it.each(["cancel", "denied-rollback", "control"] as const)(
  "keeps ASAR destination-setup cancellation inside the extraction owner: %s",
  async (mode) => {
    const root = await createTestTempDirectory("rea-asar-source-cancel-");
    const contents = join(root, "contents");
    await mkdir(contents);
    const payload = "owned payload\n";
    await writeFile(join(contents, "payload.txt"), payload);
    const archive = join(root, "fixture.asar");
    await createPackage(contents, archive);
    const client = new ArtifactProvider(process.env).createClient({
      path: archive,
      sourcePath: archive,
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
      kind: "archive",
      format: "asar",
    });
    const output = join(root, "output");
    const controller = new AbortController();
    const reason = new Error("cancel during destination preparation");
    const originalWrite = SafeOutputTree.prototype.write;
    const originalRollback = SafeOutputTree.prototype.rollback;
    const rollbackOwners: SafeOutputTree[] = [];
    let denyRollback = mode === "denied-rollback";
    let source: Readable | undefined;
    const write = vi
      .spyOn(SafeOutputTree.prototype, "write")
      .mockImplementation(function (
        this: SafeOutputTree,
        ...args: Parameters<SafeOutputTree["write"]>
      ) {
        source = args[1];
        // The real write has entered its first destination-filesystem await.
        const pending = originalWrite.apply(this, args);
        if (mode !== "control") controller.abort(reason);
        return pending;
      });
    const rollback = vi
      .spyOn(SafeOutputTree.prototype, "rollback")
      .mockImplementation(async function (this: SafeOutputTree) {
        rollbackOwners.push(this);
        if (denyRollback) throw new Error("controlled rollback denial");
        return originalRollback.call(this);
      });
    try {
      const result = await client.execute(
        "extract_artifact",
        { output_root: output },
        { signal: controller.signal },
      );
      expect(source?.closed).toBe(true);
      write.mockRestore();
      if (mode === "control") {
        expect(result.ok).toBe(true);
        expect(await readFile(join(output, "payload.txt"), "utf8")).toBe(
          payload,
        );
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: { _tag: "ArtifactOperationError", reason: "cancelled" },
        });
        if (result.ok) throw new Error("Expected cancellation");
        expect(result.error.cause).toBe(reason);
        expect(result.error.cleanupIncomplete).toBe(denyRollback);
        if (denyRollback) {
          expect(rollbackOwners).toHaveLength(1);
          await access(output);
        } else
          await expect(access(output)).rejects.toMatchObject({
            code: "ENOENT",
          });
        denyRollback = false;
        const retry = await client.execute("extract_artifact", {
          output_root: output,
        });
        expect(retry.ok).toBe(true);
        expect(await readFile(join(output, "payload.txt"), "utf8")).toBe(
          payload,
        );
        if (mode === "denied-rollback") {
          expect(rollbackOwners).toHaveLength(2);
          expect(rollbackOwners[1]).toBe(rollbackOwners[0]);
          expect(result.error.cleanupIncomplete).toBe(false);
        }
      }
      expect(await client.close()).toMatchObject({ ok: true });
    } finally {
      denyRollback = false;
      write.mockRestore();
      await client.close();
      rollback.mockRestore();
    }
  },
);

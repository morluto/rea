import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";

import {
  BUILD_REQUEST as REQUEST,
  BUILD_TASK as TASK,
  buildCaptureFakes,
} from "../../fixtures/buildCaptureFakes.js";
import { callOk, startBuildComputer } from "../../fixtures/buildComputerMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// A made-up value, never a real credential.
const VALUE = "e-Plum7-Kite-Throwaway-42";

/** The bytes of each gzip file REA decompressed, in order. */
const gunzipped = vi.hoisted(() => [] as Uint8Array[]);
vi.mock(
  "../../../src/domain/desktop/gzipDocument.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/domain/desktop/gzipDocument.js")
      >();
    return {
      ...actual,
      gunzip: (...args: Parameters<typeof actual.gunzip>) => {
        gunzipped.push(args[0]);
        return actual.gunzip(...args);
      },
    };
  },
);

it("decompresses a gzip seed file once to check it for known secrets and its size", async () => {
  // A secret the folder holds, so the export scans every file for it too.
  const config = await createTestTempDirectory("xdg-config-");
  const folder = join(config, "rea", "build-secrets");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, "master"), VALUE);
  await chmod(join(folder, "master"), 0o600);
  const { client, outputs } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  await callOk(client, "stop_build_capture", { computer_id: id });
  const seed = join(outputs.bundle, "envs/notes/seed/Documents");
  await mkdir(seed, { recursive: true });
  const compressed = gzipSync(Buffer.from(`setting=${VALUE}\n`));
  await writeFile(join(seed, "credential.txt.gz"), compressed);
  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  gunzipped.length = 0;
  const refused = await client.callTool({
    name: "export_build_environment",
    arguments: { computer_id: id, tasks: [{ task: TASK }], directory },
  });
  const { error } = parseMcpToolError(refused as CallToolResult);
  expect(error.code).toBe("invalid_request");
  // The known secret is only inside the gzip file.
  expect(error.message).toContain("credential.txt.gz");
  expect(error.message).toContain("master");
  expect(
    gunzipped.filter((bytes) => Buffer.from(bytes).equals(compressed)),
  ).toHaveLength(1);
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});

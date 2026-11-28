import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../../tests/fixtures/temporaryDirectory.js";
import { runWithAnalysisOperationSnapshot } from "../../../domain/analysisOperationSnapshot.js";
import { playwrightTraceLimits } from "../../../domain/playwrightTrace/playwrightTrace.js";
import { ArtifactResourceScope } from "../../../resources/ArtifactResourceScope.js";
import { PlaywrightTraceDecoder } from "./PlaywrightTraceDecoder.js";

const zipWithMembers = async (members: readonly string[]) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const member of members) await writer.add(member, new TextReader("a"));
  const root = await createTestTempDirectory("rea-trace-member-count-");
  const path = join(root, "trace.zip");
  await writeFile(path, Buffer.from(await writer.close()));
  return path;
};

const inspect = async (path: string) => {
  const resources = new ArtifactResourceScope();
  try {
    return await runWithAnalysisOperationSnapshot(
      { revision: 1, overrides: { "artifact.member_count": 1 } },
      () =>
        new PlaywrightTraceDecoder(resources).inspect(
          path,
          playwrightTraceLimits(),
        ),
    );
  } finally {
    await resources.close();
  }
};

it("reports a trace ZIP past the session member count as a count", async () => {
  const result = await inspect(await zipWithMembers(["a.txt", "b.txt"]));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("artifact_limits.zip.member_count");
  expect(result.error.message).not.toContain("expansion allowance");
  expect(result.error.limit).toMatchObject({
    setting: "artifact.member_count",
    effective_value: 1,
    unit: "count",
    parameter: "artifact_limits.zip.member_count",
    source: "runtime",
  });
});

it("keeps a one-member trace archive inside the session member count", async () => {
  const result = await inspect(await zipWithMembers(["notes.txt"]));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("no Playwright trace");
  expect(result.error.limit).toBeUndefined();
});

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("refuses changed admitted archives over stdio MCP before publishing extraction and accepts an explicit reopen", async () => {
  const root = await createTestTempDirectory("rea-admitted-archive-mcp-");
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  const path = join(root, "selected.zip");
  const writeArchive = async (value: string) => {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add("payload.txt", new TextReader(value));
    await writeFile(path, await zip.close());
  };
  await writeArchive("admitted version one");
  const { call } = await connectLocalToolsMcp({
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    REA_MCP_TOOL_FAMILIES: "session,artifact",
  });
  expect((await call("open_binary", { path })).isError).not.toBe(true);
  const openedTemporaryBaseline = (await readdir(temporary)).sort();
  await writeArchive("changed version two");
  for (const operation of ["inspect_artifact", "extract_artifact"]) {
    const refused = parseMcpToolError(await call(operation, {}));
    expect(refused.error).toMatchObject({
      code: "artifact_operation_failed",
      details: { reason: "integrity" },
      message: expect.stringContaining("Reopen the selected artifact"),
    });
    expect((await readdir(temporary)).sort()).toEqual(openedTemporaryBaseline);
  }
  expect((await call("open_binary", { path })).isError).not.toBe(true);
  const extracted = await call("extract_artifact", {});
  expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
  const result = artifactExtractionResultSchema.parse(
    parseEvidence(extracted.structuredContent).normalized_result,
  );
  try {
    expect(dirname(result.output_root)).toBe(temporary);
    expect(
      await readFile(join(result.output_root, "payload.txt"), "utf8"),
    ).toBe("changed version two");
  } finally {
    await rm(result.output_root, { recursive: true, force: true });
  }
  const reopenedTemporaryBaseline = (await readdir(temporary)).sort();
  await writeFile(path, "not an archive");
  for (const operation of ["inspect_artifact", "extract_artifact"]) {
    const refused = parseMcpToolError(await call(operation, {}));
    expect(refused.error).toMatchObject({
      code: "artifact_operation_failed",
      details: { reason: "integrity" },
    });
    expect((await readdir(temporary)).sort()).toEqual(
      reopenedTemporaryBaseline,
    );
  }
});

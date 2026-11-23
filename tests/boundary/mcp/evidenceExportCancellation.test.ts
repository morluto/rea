import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { readEvidenceBundle } from "../../../src/application/EvidenceBundleFiles.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { phaseGate } from "../../support/lifecycleHarness.js";

it.each([false, true])(
  "stops an SDK export cancellation before publication and keeps the same session usable (overwrite: %s)",
  async (overwrite) => {
    const root = await createTestTempDirectory("rea-mcp-export-cancel-");
    const path = join(root, "bundle.json");
    if (overwrite) await writeFile(path, "original destination");
    const session = createTestBinarySession(() => {
      throw new Error("Evidence export must not start a binary provider");
    });
    const evidence = createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "fixture_observation",
        parameters: {},
        result: { observed: "雪😀" },
      },
    );
    expect(session.recordEvidence(evidence).ok).toBe(true);
    const server = createServer({ kind: "session", session });
    const client = new Client(
      {
        name: "evidence-export-cancellation",
        version: "1",
      },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    const controller = new AbortController();
    const stagedWrite = phaseGate<string>();
    onTestFinished(async () => {
      controller.abort();
      stagedWrite.release();
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const closeFile = OwnedStagedOutput.prototype.closeFile;
    const stagedClose = vi
      .spyOn(OwnedStagedOutput.prototype, "closeFile")
      .mockImplementationOnce(async function (this: OwnedStagedOutput) {
        await closeFile.call(this);
        await stagedWrite.hold(this.directory);
      });
    onTestFinished(() => stagedClose.mockRestore());
    const cancellation = client
      .callTool(
        { name: "export_evidence_bundle", arguments: { path, overwrite } },
        { signal: controller.signal },
      )
      .then(
        () => "completed",
        (error: unknown) => error,
      );
    const directory = await stagedWrite.reached(
      cancellation,
      "staged file close",
    );
    expect((await stat(join(directory, "content"))).size).toBeGreaterThan(0);
    controller.abort(new Error("SDK export cancellation verification"));
    expect(await cancellation).toMatchObject({
      message: expect.stringContaining("SDK export cancellation verification"),
    });
    await client.ping();
    stagedWrite.release();
    await expect
      .poll(() => readdir(root))
      .toEqual(overwrite ? ["bundle.json"] : []);
    if (overwrite)
      expect(await readFile(path, "utf8")).toBe("original destination");
    expect(session.hasEvidence(evidence.evidence_id)).toBe(true);
    await client.ping();
    const next = await client.callTool({
      name: "export_evidence_bundle",
      arguments: { path, overwrite },
    });
    expect(next.isError, JSON.stringify(next)).not.toBe(true);
    expect(await readEvidenceBundle(path)).toMatchObject({
      ok: true,
      value: {
        records: [
          {
            evidence_id: evidence.evidence_id,
            normalized_result: evidence.normalized_result,
          },
        ],
      },
    });
    await client.ping();
  },
);

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { machoImage } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { createArtifactBinarySession } from "../../../src/composition/binary.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const TRAVERSAL_UNKNOWN =
  "Producer traversal coverage is unknown; missing matches do not prove source absence.";

const writeBundle = async (withFifo: boolean): Promise<string> => {
  const root = await createTestTempDirectory("rea-inspection-coverage-");
  const bundle = join(root, "Fixture.app");
  await mkdir(bundle);
  await writeFile(
    join(bundle, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>main</string></dict></plist>",
  );
  await writeFile(join(bundle, "main"), machoImage({}));
  if (withFifo) execFileSync("mkfifo", [join(bundle, "omitted.fifo")]);
  return bundle;
};

const connect = async () => {
  const session = await createArtifactBinarySession(process.env);
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "inspection-coverage", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const definition = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  expect(definition?.outputSchema).toBeDefined();
  const outputSchema: Record<string, unknown> = definition!.outputSchema!;
  const viewOutput = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(outputSchema);
  return { client, server, viewOutput };
};

describe.skipIf(process.platform === "win32")(
  "inspect_artifact traversal coverage",
  () => {
    it.each([
      {
        withFifo: true,
        status: "partial",
        sourceCoverage: { scope: "container-entries", status: "unknown" },
      },
      {
        withFifo: false,
        status: "complete-within-substeps",
        sourceCoverage: { scope: "container-entries", status: "complete" },
      },
    ] as const)(
      "derives inspection and summary coverage from inventory traversal (FIFO: $withFifo)",
      async ({ withFifo, status, sourceCoverage }) => {
        const path = await writeBundle(withFifo);
        const { client, server, viewOutput } = await connect();
        try {
          const opened = await client.callTool({
            name: "open_binary",
            arguments: { path },
          });
          expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
          const inspected = await client.callTool({
            name: "inspect_artifact",
            arguments: {},
          });
          expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
          const parent = parseEvidence(inspected.structuredContent);
          const inspection = artifactInspectionResultSchema.parse(
            parent.normalized_result,
          );
          const inventory = inspection.substeps[0]!.evidence.normalized_result;
          expect(inventory.coverage).toEqual(sourceCoverage);
          expect(inspection.coverage.status).toBe(status);

          const summaries = [
            await client.callTool({
              name: "inspect_analysis_view",
              arguments: {
                source: {
                  kind: "retained-evidence",
                  evidence_id: parent.evidence_id,
                },
                view: { kind: "summary" },
              },
            }),
            await client.callTool({
              name: "inspect_artifact",
              arguments: { detail: "summary" },
            }),
          ];
          for (const reply of summaries) {
            expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
            expect(
              viewOutput(reply.structuredContent),
              JSON.stringify(viewOutput.errors),
            ).toBe(true);
            const view = analysisViewResultSchema.parse(
              parseEvidence(reply.structuredContent).normalized_result,
            );
            if (view.kind !== "summary" || !("source_complete" in view.summary))
              throw new Error("Expected an artifact inventory summary");
            expect(view.summary.source_complete).toBe(true);
            expect(view.summary.source_coverage).toEqual(sourceCoverage);
            expect(view.summary.inspection?.coverage.status).toBe(status);
            expect(view.unknowns.includes(TRAVERSAL_UNKNOWN)).toBe(withFifo);
          }
        } finally {
          await client.close();
          await server.close();
        }
      },
      30_000,
    );
  },
);

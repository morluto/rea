import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { z } from "zod";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  evidenceBundleSchema,
} from "../../../src/domain/evidenceBundle.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import type { AnalysisProvider } from "../../../src/application/AnalysisProvider.js";

const SNAPSHOT_PROFILE = createAnalysisProfile(
  { id: "fixture", name: "Fixture analysis provider", version: "1" },
  1,
  { fixture: true },
);

export interface SessionMcpHarness {
  readonly mcp: Client;
  readonly first: string;
  readonly second: string;
  readonly closed: string[];
  readonly resourceListChanges: () => number;
  readonly unknownResourceUpdates: () => number;
}

export const createSessionMcpHarness = async (
  root: string,
  provider: (closed: string[]) => AnalysisProvider,
  resources: Array<{ close(): Promise<unknown> }>,
): Promise<SessionMcpHarness> => {
  const first = join(root, "first.hop");
  const second = join(root, "second.hop");
  await Promise.all([writeFile(first, "one"), writeFile(second, "two")]);
  const closed: string[] = [];
  const session = createTestBinarySession(provider(closed), {
    resolveAnalysisProfile: () =>
      Promise.resolve(ok({ profile: SNAPSHOT_PROFILE, compatibility: {} })),
  });
  const filePolicy = {
    roots: [root],
    maxBytes: 1024 * 1024,
    maxDepth: 68,
    maxStringLength: 1024,
    maxNodes: 10_000,
  };
  const server = createServer(session, session, {
    logger: silentLogger,
    evidenceFilePolicy: filePolicy,
    analysisSnapshotFilePolicy: filePolicy,
  });
  const mcp = new Client({ name: "session-test", version: "1.0.0" });
  let resourceChanges = 0;
  let unknownUpdates = 0;
  mcp.setNotificationHandler("notifications/resources/list_changed", () => {
    resourceChanges += 1;
  });
  mcp.setNotificationHandler("notifications/resources/updated", (notice) => {
    if (notice.params.uri.startsWith("rea://unknown/")) unknownUpdates += 1;
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(mcp, server);
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return {
    mcp,
    first,
    second,
    closed,
    resourceListChanges: () => resourceChanges,
    unknownResourceUpdates: () => unknownUpdates,
  };
};

export const snapshotAndRecordUnknown = async (
  harness: SessionMcpHarness,
  root: string,
): Promise<{
  recordedUnknown: { unknown_id: string; revision: number };
  changesBeforeMutation: number;
}> => {
  const { mcp } = harness;
  const snapshotted = await mcp.callTool({
    name: "snapshot_evidence_bundle",
    arguments: {},
  });
  const snapshotResult = z
    .object({ result: z.object({ bundle_uri: z.string() }) })
    .parse(structured(snapshotted)).result;
  const bundleResource = await mcp.readResource({
    uri: snapshotResult.bundle_uri,
  });
  const bundle = evidenceBundleSchema.parse(
    JSON.parse(
      z.object({ text: z.string() }).parse(bundleResource.contents[0]).text,
    ),
  );
  expect(bundle.records).toHaveLength(1);
  const evidencePath = join(root, "evidence.json");
  expect(
    structured(
      await mcp.callTool({
        name: "export_evidence_bundle",
        arguments: { path: evidencePath },
      }),
    ).result,
  ).toMatchObject({ path: evidencePath, records: 1 });
  expect(
    structured(
      await mcp.callTool({
        name: "import_evidence_bundle",
        arguments: { path: evidencePath },
      }),
    ).result,
  ).toEqual({ imported: 0, unknowns_added: 0, total: 1 });
  const externalEvidencePath = join(root, "external-evidence.json");
  await writeFile(
    externalEvidencePath,
    JSON.stringify(
      createEvidenceBundle([
        createEvidence(
          undefined,
          { id: "fixture", name: "Fixture", version: "1" },
          { operation: "external_observation", parameters: {}, result: true },
        ),
      ]),
    ),
  );
  expect(
    structured(
      await mcp.callTool({
        name: "import_evidence_bundle",
        arguments: { path: externalEvidencePath },
      }),
    ).result,
  ).toEqual({ imported: 1, unknowns_added: 0, total: 2 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(harness.resourceListChanges()).toBe(0);
  const changesBeforeMutation = harness.resourceListChanges();
  const recordedUnknown = z
    .object({
      result: z.object({ unknown_id: z.string(), revision: z.number() }),
    })
    .parse(
      structured(
        await mcp.callTool({
          name: "record_unknown",
          arguments: {
            approved: true,
            question: "Does the alternate branch execute?",
            severity: "medium",
            domain: "control-flow",
            required_authority: "controlled-replay",
            required_confidence: "observed",
            required_environment: null,
            recommended_probes: [],
            relationships: [],
          },
        }),
      ),
    ).result;
  expect(recordedUnknown.revision).toBe(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(harness.resourceListChanges()).toBe(changesBeforeMutation);
  const listedUnknowns = await mcp.callTool({
    name: "list_unknowns",
    arguments: {},
  });
  expect(listedUnknowns.isError).not.toBe(true);
  expect(
    z
      .object({ result: z.object({ items: z.array(z.unknown()) }) })
      .parse(structured(listedUnknowns)).result.items,
  ).toHaveLength(1);
  return { recordedUnknown, changesBeforeMutation };
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

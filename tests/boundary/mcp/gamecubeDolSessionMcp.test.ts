import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { readAnalysisSnapshot } from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { buildGamecubeDol } from "../../../src/domain/gamecubeDol.fixture.js";
import { silentLogger } from "../../../src/logger.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("opens a GameCube DOL and reports its target through the advertised lifecycle schemas", async () => {
  const root = await createTestTempDirectory("rea-dol-session-mcp-");
  const path = join(root, "game.dol");
  await writeFile(path, buildGamecubeDol());
  const { client } = await createApplicationMcpHarness({
    session: createTestBinarySession(createCacheProvider([])),
    serverOptions: {
      logger: silentLogger,
      environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact" },
    },
  });
  // The SDK validates successful replies against the listed output schemas.
  const { tools } = await client.listTools();
  for (const name of ["open_binary", "binary_session"]) {
    expect(
      tools.find((tool) => tool.name === name)?.outputSchema,
      name,
    ).toBeDefined();
  }

  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path, format: "gamecube-dol" },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  expect(opened.structuredContent).toMatchObject({
    result: {
      format: "gamecube-dol",
      kind: "executable",
      architecture: "powerpc",
      entry_point: "0x80003100",
    },
  });

  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  expect(status.isError, JSON.stringify(status)).not.toBe(true);
  expect(status.structuredContent).toMatchObject({
    result: {
      format: "gamecube-dol",
      kind: "executable",
      architecture: "powerpc",
      entry_point: "0x80003100",
    },
  });
});

// #7290: the bundle manifest lacked the DOL subject declaration, so DOL
// Evidence could not be bundled or saved with close_binary.
it("saves a GameCube DOL snapshot and replays it after reopening", async () => {
  const root = await createTestTempDirectory("rea-dol-snapshot-mcp-");
  const path = join(root, "game.dol");
  const snapshotPath = join(root, "analysis.json");
  await writeFile(path, buildGamecubeDol());
  const calls: string[] = [];
  const { client } = await createApplicationMcpHarness({
    session: createTestBinarySession(createCacheProvider(calls)),
    serverOptions: { logger: silentLogger },
    clientIdentity: { name: "dol-snapshot-mcp", version: "1" },
  });
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path, format: "gamecube-dol" },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  // A document selector makes this read replayable from a snapshot.
  const query = {
    name: "address_name",
    arguments: { address: "0x80003100", document: "game.dol" },
  };
  const named = await client.callTool(query);
  expect(named.isError, JSON.stringify(named)).not.toBe(true);
  const original = parseEvidence(named.structuredContent);

  const saved = await client.callTool({
    name: "close_binary",
    arguments: { snapshot_path: snapshotPath },
  });
  expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
  const snapshot = await readAnalysisSnapshot(snapshotPath);
  if (!snapshot.ok) throw snapshot.error;
  expect(snapshot.value.target).toMatchObject({
    kind: "executable",
    identity: {
      kind: "file",
      sha256: createHash("sha256").update(buildGamecubeDol()).digest("hex"),
      format: "gamecube-dol",
      architecture: "powerpc",
      selection: { kind: "entry-point", entry_point: "0x80003100" },
    },
  });
  expect(snapshot.value.entries).toHaveLength(1);
  expect(snapshot.value.evidence_bundle.artifacts).toEqual([
    expect.objectContaining({
      format: "gamecube-dol",
      architecture: "powerpc",
      digest: { sha256: snapshot.value.target.identity.sha256 },
    }),
  ]);

  const reopened = await client.callTool({
    name: "open_binary",
    arguments: { path, format: "gamecube-dol", snapshot_path: snapshotPath },
  });
  expect(reopened.isError, JSON.stringify(reopened)).not.toBe(true);
  const replayed = parseEvidence(
    (await client.callTool(query)).structuredContent,
  );
  expect(original.normalized_result).toBe("address_name");
  expect(replayed.subject).toEqual(original.subject);
  expect(replayed.normalized_result).toEqual(original.normalized_result);
  expect(replayed.limitations).toContainEqual(
    expect.stringMatching(/snapshot.*did not re.run the provider/iu),
  );
  expect(calls.filter((operation) => operation === "address_name")).toEqual([
    "address_name",
  ]);
});

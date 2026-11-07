import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { ProjectEvidenceStore } from "../../../src/application/investigation/ProjectEvidenceStore.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { INVESTIGATION_EXAMPLES } from "../../../src/contracts/investigationExamples.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const connect = async (evidenceStore: ProjectEvidenceStore) => {
  const session = createTestBinarySession(
    () => {
      throw new Error("Project Evidence storage must not launch a provider");
    },
    { evidenceStore },
  );
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "project-store-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { session, server, client };
};

const close = async (
  connection: Awaited<ReturnType<typeof connect>>,
): Promise<void> => {
  await Promise.allSettled([
    connection.client.close(),
    connection.server.close(),
  ]);
  const closed = await connection.session.close();
  expect(closed.ok, JSON.stringify(closed)).toBe(true);
};

it("authenticates stored Evidence and rejects tampered records", async () => {
  const root = await createTestTempDirectory("rea-project-store-");
  const storeRoot = join(root, ".rea", "evidence");
  const store = new ProjectEvidenceStore(storeRoot);
  const dossier = FUNCTION_COMPARISON_EXAMPLE.left;
  store.persist(dossier);
  expect(await store.flush()).toMatchObject({ ok: true });
  expect(store.has(dossier.evidence_id)).toBe(true);
  expect(store.read(dossier.evidence_id)).toEqual(dossier);
  expect(store.read("../../etc/passwd")).toBeUndefined();

  const path = join(storeRoot, "records", `${dossier.evidence_id}.json`);
  await writeFile(
    path,
    JSON.stringify({ ...dossier, limitations: ["tampered"] }),
  );
  const reloaded = new ProjectEvidenceStore(storeRoot);
  expect(reloaded.read(dossier.evidence_id)).toBeUndefined();
  expect(reloaded.has(dossier.evidence_id)).toBe(false);
});

it("reports a durable write failure instead of claiming persistence", async () => {
  const root = await createTestTempDirectory("rea-project-store-failure-");
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "");
  const store = new ProjectEvidenceStore(join(blocker, "evidence"));
  store.persist(FUNCTION_COMPARISON_EXAMPLE.left);
  const flushed = await store.flush();
  expect(flushed.ok).toBe(false);
});

it("surfaces a failed store flush through session close", async () => {
  const root = await createTestTempDirectory("rea-project-store-close-");
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "");
  const store = new ProjectEvidenceStore(join(blocker, "evidence"));
  const session = createTestBinarySession(
    () => {
      throw new Error("Project Evidence storage must not launch a provider");
    },
    { evidenceStore: store },
  );
  expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.left).ok).toBe(
    true,
  );
  const closed = await session.close();
  expect(closed.ok).toBe(false);
});

it("persists the ledger's record when the caller edits its own object", async () => {
  const root = await createTestTempDirectory("rea-project-store-mutation-");
  const storeRoot = join(root, ".rea", "evidence");
  const store = new ProjectEvidenceStore(storeRoot);
  const session = createTestBinarySession(
    () => {
      throw new Error("Project Evidence storage must not launch a provider");
    },
    { evidenceStore: store },
  );
  const callerRecord = structuredClone(FUNCTION_COMPARISON_EXAMPLE.left);
  expect(session.recordEvidence(callerRecord).ok).toBe(true);
  // The recorded copy is the ledger's; the caller still holds a mutable object.
  const editable = callerRecord as { parameters: Record<string, unknown> };
  editable.parameters = { ...callerRecord.parameters, edited: true };
  const closed = await session.close();
  expect(closed.ok, JSON.stringify(closed)).toBe(true);

  const reopened = new ProjectEvidenceStore(storeRoot);
  expect(reopened.read(callerRecord.evidence_id)).toEqual(
    FUNCTION_COMPARISON_EXAMPLE.left,
  );
});

it("reuses project Evidence across sessions without resending it", async () => {
  const root = await createTestTempDirectory("rea-project-store-session-");
  const storeRoot = join(root, ".rea", "evidence");
  const first = await connect(new ProjectEvidenceStore(storeRoot));
  const dossier = FUNCTION_COMPARISON_EXAMPLE.left;
  try {
    const compared = await first.client.callTool({
      name: "compare_functions",
      arguments: {
        left: FUNCTION_COMPARISON_EXAMPLE.left,
        right: FUNCTION_COMPARISON_EXAMPLE.right,
      },
    });
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    expect(parseEvidence(compared.structuredContent)).toBeDefined();
  } finally {
    await close(first);
  }

  const store = new ProjectEvidenceStore(storeRoot);
  expect(store.read(dossier.evidence_id)).toEqual(dossier);
  const second = await connect(store);
  try {
    const path = await second.client.callTool({
      name: "build_call_path",
      arguments: {
        ...INVESTIGATION_EXAMPLES.build_call_path,
        functions: [
          { kind: "retained-evidence", evidence_id: dossier.evidence_id },
        ],
      },
    });
    expect(path.isError, JSON.stringify(path)).not.toBe(true);
    expect(parseEvidence(path.structuredContent)).toMatchObject({
      normalized_result: { status: "found", shortest_hops: 0 },
      evidence_links: [dossier.evidence_id],
    });
  } finally {
    await close(second);
  }
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import { composeBinarySessionFromFactory } from "../../../src/application/BinarySessionComposition.js";
import { createPermissionPolicy } from "../../../src/domain/permissionPolicy.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (result.structuredContent === undefined)
    throw new Error("expected structured MCP content");
  return result.structuredContent as Record<string, unknown>;
};

const createSession = () =>
  composeBinarySessionFromFactory(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));

describe("evidence bundle release", () => {
  it("notifies snapshot observers and invalidates the retained URI", async () => {
    const session = createSession();
    const server = createServer(session, session);
    const resourceUpdated = vi.spyOn(server.server, "sendResourceUpdated");
    const client = new Client({ name: "release-test", version: "1" });
    let updates = 0;
    session.onAnalysisSnapshotChanged(() => {
      updates += 1;
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const snapshot = z
        .object({
          result: z.object({
            bundle_uri: z.string(),
            bundle_digest: z.string(),
          }),
        })
        .parse(
          structured(
            await client.callTool({
              name: "snapshot_evidence_bundle",
              arguments: {},
            }),
          ),
        ).result;
      expect(
        structured(
          await client.callTool({
            name: "release_evidence_bundle",
            arguments: { bundle_digest: snapshot.bundle_digest },
          }),
        ).result,
      ).toEqual({
        bundle_digest: snapshot.bundle_digest,
        released: true,
      });
      expect(updates).toBe(1);
      expect(resourceUpdated).toHaveBeenCalledWith({
        uri: snapshot.bundle_uri,
      });
      await expect(
        client.readResource({ uri: snapshot.bundle_uri }),
      ).rejects.toThrow(/not found/iu);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("requires evidence-write permission before releasing a bundle", async () => {
    const session = createSession();
    const server = createServer(session, session, {
      permissionAuthority: new PermissionAuthority(createPermissionPolicy([])),
    });
    const client = new Client({
      name: "release-permission-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const snapshot = z
        .object({ result: z.object({ bundle_digest: z.string() }) })
        .parse(
          structured(
            await client.callTool({
              name: "snapshot_evidence_bundle",
              arguments: {},
            }),
          ),
        ).result;
      const release = await client.callTool({
        name: "release_evidence_bundle",
        arguments: { bundle_digest: snapshot.bundle_digest },
      });
      expect(release.isError).toBe(true);
      expect(
        session.retainedEvidenceBundle(snapshot.bundle_digest),
      ).toBeDefined();
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });
});

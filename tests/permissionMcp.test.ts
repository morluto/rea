import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../src/application/AnalysisProvider.js";
import { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../src/domain/permissionPolicy.js";
import { createServer } from "../src/server/createServer.js";

describe("MCP permission preflight", () => {
  it("denies extraction before dispatch and returns exact typed remediation", async () => {
    const outputRoot = join(await realpath("/tmp"), "rea-permission-denied");
    let dispatches = 0;
    const analysis: AnalysisOperationPort = {
      execute: () => {
        dispatches += 1;
        throw new Error("provider must not run");
      },
    };
    const server = createServer(analysis, undefined, {
      permissionAuthority: new PermissionAuthority(createPermissionPolicy([])),
    });
    const client = new Client({ name: "permission-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "extract_artifact",
        arguments: {
          approved: true,
          output_root: outputRoot,
          occurrence_ids: [`occ_${"0".repeat(64)}`],
        },
      });

      expect(dispatches).toBe(0);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "permission_required",
            details: {
              capability: "artifact_extract",
              missing: { roots: [outputRoot] },
            },
            remediation: {
              restart_required: false,
              elicitation_supported: false,
            },
          },
        },
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});

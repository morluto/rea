import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../src/application/AnalysisProvider.js";
import { AnalysisProviderRegistry } from "../src/application/AnalysisProviderRegistry.js";
import { BinarySession } from "../src/application/BinarySession.js";
import { SessionProviderRouter } from "../src/application/SessionProviderRouter.js";
import { createAnalysisProfile } from "../src/domain/analysisProfile.js";
import { ok } from "../src/domain/result.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server/createServer.js";

const resources: Array<{ close(): Promise<unknown> }> = [];
let directory: string | undefined;
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("provider selection over MCP", () => {
  it("keeps open_binary and binary_session binding semantics exact", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-provider-mcp-"));
    const target = join(directory, "fixture.hop");
    await writeFile(target, "fixture");
    const starts: string[] = [];
    const session = new BinarySession(
      SessionProviderRouter.selectable(
        new AnalysisProviderRegistry([
          candidate("beta", starts),
          candidate("alpha", starts),
        ]),
        [],
      ),
    );
    const server = createServer(session, session, { logger: silentLogger });
    const mcp = new Client({ name: "provider-selection", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const before = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(before.result).toMatchObject({
      open: false,
      analysis_provider_binding: null,
      analysis_provider_candidates: [
        {
          provider: { id: "alpha" },
          target_support: { status: "unknown" },
          selected: false,
        },
        {
          provider: { id: "beta" },
          target_support: { status: "unknown" },
          selected: false,
        },
      ],
    });
    expect(starts).toEqual([]);

    const malformed = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "Beta" },
    });
    expect(malformed.isError).toBe(true);
    expect(starts).toEqual([]);

    const ambiguous = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    expect(ambiguous.isError).toBe(true);
    expect(structured(ambiguous)).toMatchObject({
      error: {
        code: "capability_unavailable",
        details: {
          selection_reason: "ambiguous",
          requested_provider_id: "auto",
          candidate_ids: ["alpha", "beta"],
        },
      },
    });
    expect(starts).toEqual([]);

    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "beta" },
    });
    expect(opened.isError).not.toBe(true);
    expect(starts).toEqual([]);

    const observed = await mcp.callTool({
      name: "address_name",
      arguments: {},
    });
    expect(observed.isError).not.toBe(true);
    expect(structured(observed)).toMatchObject({
      result: "beta:address_name",
      evidence_id: expect.stringMatching(/^ev_/u),
    });
    expect(starts).toEqual(["beta"]);

    const status = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(status.result).toMatchObject({
      open: true,
      analysis_provider_binding: {
        provider: { id: "beta", version: "1" },
        selection_source: "request",
      },
      analysis_provider_candidates: [
        { provider: { id: "alpha" }, selected: false },
        { provider: { id: "beta", version: "1" }, selected: true },
      ],
    });

    const unknown = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "missing" },
    });
    expect(unknown.isError).toBe(true);
    expect(structured(unknown)).toMatchObject({
      error: { details: { selection_reason: "unknown_provider" } },
    });
    expect(
      structured(await mcp.callTool({ name: "binary_session", arguments: {} }))
        .result,
    ).toMatchObject({
      analysis_provider_binding: { provider: { id: "beta" } },
    });
  });
});

const candidate = (id: string, starts: string[]): AnalysisProviderCandidate => {
  const identity: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: null,
  };
  return {
    identity: () => identity,
    capabilities: () => [capability(identity)],
    inspectAvailability: () => ({
      status: "available",
      code: null,
      reason: null,
      diagnostics: { executable_path: `/opt/${id}/bin/analyze` },
    }),
    inspectTargetSupport: () => ({
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    resolveAnalysisProfile: () =>
      Promise.resolve(
        ok({
          profile: createAnalysisProfile(
            { id, name: identity.name, version: "1" },
            1,
            { fixture: id },
          ),
          compatibility: {},
        }),
      ),
    createClient: (_target, profile) => {
      starts.push(id);
      return {
        execute: (operation) =>
          Promise.resolve(
            ok(
              createAnalysisExecution(
                `${id}:${operation}`,
                profile?.provider ?? identity,
              ),
            ),
          ),
        close: () => Promise.resolve(),
      };
    },
  };
};

const capability = (provider: ProviderIdentity): CapabilityDescriptor => ({
  provider,
  operation: "address_name",
  inputContractVersion: 1,
  outputContractVersion: 1,
  available: true,
  reason: null,
  pagination: "none",
  exhaustive: true,
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limits: { maxResults: null, maxPayloadBytes: 1_000, timeoutMs: 1_000 },
  limitations: [],
});

const structured = (result: CallToolResult): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(result.structuredContent);

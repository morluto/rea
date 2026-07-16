import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AnalysisProviderRegistry } from "../src/application/AnalysisProviderRegistry.js";
import { BinarySession } from "../src/application/BinarySession.js";
import { createPermissionAuthority } from "../src/application/PermissionAuthority.js";
import { SessionProviderRouter } from "../src/application/SessionProviderRouter.js";
import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../src/contracts/managedWorkflowExamples.js";
import type { PermissionCeiling } from "../src/domain/permissionPolicy.js";
import { ManagedStaticProvider } from "../src/dotnet/ManagedStaticProvider.js";
import { createServer } from "../src/server/createServer.js";
import { buildManagedPeFixture } from "./fixtures/managedPe.js";

describe("managed artifact MCP tools", () => {
  it("opens a managed PE and executes the managed static provider through MCP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-mcp-"));
    const path = join(directory, "fixture.exe");
    const rightPath = join(directory, "fixture-renamed.exe");
    const runtimePath = join(directory, "dotnet");
    await writeFile(path, buildManagedPeFixture());
    await writeFile(runtimePath, "#!/bin/sh\n");
    await writeFile(
      rightPath,
      buildManagedPeFixture({ methodName: "Renamed" }),
    );
    const session = new BinarySession(
      SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), [
        new ManagedStaticProvider(),
      ]),
    );
    const runtimeCeiling: PermissionCeiling = {
      capability: "managed_runtime",
      roots: [directory],
      executables: [runtimePath],
      environment_names: [],
      network: "none",
      mount: false,
    };
    const authority = await createPermissionAuthority(
      [runtimeCeiling],
      [
        {
          ...runtimeCeiling,
          grant_id: "administrator:managed_runtime",
          lifetime: "administrator",
          operation_identity: null,
          expires_at: null,
        },
      ],
    );
    if (!authority.ok) throw authority.error;
    const server = createServer(session, session, {
      permissionAuthority: authority.value,
      managedRuntimePolicy: {
        enabled: true,
        roots: [directory],
        executablePath: runtimePath,
      },
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        evidenceFileRoots: 0,
        browserObservationEnabled: false,
        electronObservationEnabled: false,
        javascriptReplayEnabled: false,
        managedRuntimeEnabled: true,
      }),
    });
    const client = new Client({ name: "managed-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain(
        "inspect_managed_artifact",
      );
      expect(tools.tools.map(({ name }) => name)).toContain(
        "inspect_managed_members",
      );
      expect(tools.tools.map(({ name }) => name)).toContain(
        "inspect_managed_native_boundaries",
      );
      expect(tools.tools.map(({ name }) => name)).toContain(
        "compare_managed_members",
      );
      expect(tools.tools.map(({ name }) => name)).toContain(
        "import_managed_reconstruction",
      );
      expect(tools.tools.map(({ name }) => name)).toContain(
        "verify_managed_native_boundaries",
      );
      expect(tools.tools.map(({ name }) => name)).toContain(
        "plan_managed_runtime_correlation",
      );
      const verifiedNative = structured(
        await client.callTool({
          name: "verify_managed_native_boundaries",
          arguments: MANAGED_NATIVE_VERIFICATION_EXAMPLE,
        }),
      );

      expect(verifiedNative).toMatchObject({
        operation: "verify_managed_native_boundaries",
        provider: { id: "rea-dotnet-workflows" },
        confidence: "inferred",
        normalized_result: {
          summary: { verified: 1 },
          algorithm: { token_to_address_mapping: "not-inferred" },
        },
      });

      await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      const inspected = structured(
        await client.callTool({
          name: "inspect_managed_artifact",
          arguments: { reference_limit: 1 },
        }),
      );

      expect(inspected).toMatchObject({
        operation: "inspect_managed_artifact",
        provider: { id: "rea-dotnet-static" },
        subject: { local_path: path, format: "pe" },
        normalized_result: {
          classification: {
            status: "managed",
            runtime_family: "modern-dotnet",
          },
          references: { limit: 1 },
        },
      });

      const members = structured(
        await client.callTool({
          name: "inspect_managed_members",
          arguments: { method_limit: 1 },
        }),
      );

      expect(members).toMatchObject({
        operation: "inspect_managed_members",
        provider: { id: "rea-dotnet-static" },
        subject: { local_path: path, format: "pe" },
        normalized_result: {
          identity_scope: { token_identity: "build-local" },
          methods: { total: 1, returned: 1 },
          call_edges: { total: 1 },
          field_accesses: { total: 1 },
        },
      });

      const boundaries = structured(
        await client.callTool({
          name: "inspect_managed_native_boundaries",
          arguments: { import_limit: 1 },
        }),
      );

      expect(boundaries).toMatchObject({
        operation: "inspect_managed_native_boundaries",
        provider: { id: "rea-dotnet-static" },
        subject: { local_path: path, format: "pe" },
        normalized_result: {
          identity_scope: { token_identity: "build-local" },
          pinvoke_imports: { total: 0, limit: 1 },
          native_implementations: { total: 0 },
        },
      });

      await client.callTool({
        name: "open_binary",
        arguments: { path: rightPath },
      });
      const rightMembers = structured(
        await client.callTool({
          name: "inspect_managed_members",
          arguments: { method_limit: 1 },
        }),
      );
      const compared = structured(
        await client.callTool({
          name: "compare_managed_members",
          arguments: {
            left: members,
            right: rightMembers,
            limits: {
              max_method_matches: 100,
              max_field_matches: 100,
              max_candidates: 10,
            },
          },
        }),
      );

      expect(compared).toMatchObject({
        operation: "compare_managed_members",
        provider: { id: "rea-dotnet-workflows" },
        confidence: "inferred",
        normalized_result: {
          algorithm: { name_matching: "not-used" },
          matching: { exact_il_signature: 1 },
        },
      });

      const method = z
        .record(z.string(), z.unknown())
        .parse(members.normalized_result).methods;
      const methodItem = z
        .object({
          items: z.array(
            z.object({
              token: z.string(),
              signature: z.object({ raw_sha256: z.string() }),
              body: z.object({ normalized_il_sha256: z.string().nullable() }),
            }),
          ),
        })
        .parse(method).items[0];
      expect(methodItem).toBeDefined();
      if (methodItem === undefined) return;
      const imported = structured(
        await client.callTool({
          name: "import_managed_reconstruction",
          arguments: {
            static_members: members,
            decompiler: {
              name: "ilspycmd",
              version: "9.1.0.7988",
              family: "ilspy",
              executable_sha256: null,
              options: ["--type", "Example.Program"],
            },
            methods: [
              {
                token: methodItem.token,
                signature_sha256: methodItem.signature.raw_sha256,
                normalized_il_sha256: methodItem.body.normalized_il_sha256,
                reconstruction: {
                  kind: "decompiled-csharp",
                  language: "csharp",
                  text: "internal static void Main() { }",
                },
              },
            ],
            notes: ["synthetic MCP import"],
          },
        }),
      );

      expect(imported).toMatchObject({
        operation: "import_managed_reconstruction",
        provider: { id: "rea-dotnet-workflows" },
        confidence: "inferred",
        normalized_result: {
          executed: false,
          summary: { imported_methods: 1, decompiled_csharp_methods: 1 },
          methods: [
            {
              token: methodItem.token,
              validation: { canonical_observation: false },
            },
          ],
        },
      });
      const planned = structured(
        await client.callTool({
          name: "plan_managed_runtime_correlation",
          arguments: {
            static_members: members,
            method: {
              token: methodItem.token,
              signature_sha256: methodItem.signature.raw_sha256,
              normalized_il_sha256: methodItem.body.normalized_il_sha256,
            },
            requested_effect: "attach",
            host: {
              os: "linux",
              clr_family: "dotnet",
              architecture: "x86_64",
            },
            bounds: {
              timeout_ms: 5000,
              max_threads: 32,
              max_output_bytes: 65536,
              allow_network: false,
              allow_ui: false,
            },
          },
        }),
      );

      expect(planned).toMatchObject({
        operation: "plan_managed_runtime_correlation",
        provider: { id: "rea-dotnet-workflows" },
        confidence: "derived",
        normalized_result: {
          executed: false,
          authority_model: { capability: "managed_runtime" },
          requested_runtime: { effect: "attach", network: "none" },
          effect_taxonomy: { attaches_process: true },
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
      await session.close();
    }
  }, 30_000);
});

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

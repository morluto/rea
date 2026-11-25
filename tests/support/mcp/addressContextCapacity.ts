import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type OnTestFinishedHandler } from "vitest";

import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { err, ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import { createFixtureProviderIdentity } from "../../fixtures/analysisExecution.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ownArtifactSession } from "./artifactSession.js";
import type { TestMcp } from "./mcpFixture.js";

/** Inspect the same address with an 8,000-byte Evidence store and caller-sized facets. */
export const inspectCapacityContext = async (
  mcp: TestMcp,
  onTestFinished: (handler: OnTestFinishedHandler) => void,
  environment: NodeJS.ProcessEnv,
  facets: { procedureName: string; comment?: string; inline_comment?: string },
) => {
  const identity = createFixtureProviderIdentity();
  const directory = await createTestTempDirectory("rea-context-capacity-");
  const target = join(directory, "fixture.com");
  await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const router = createTestProviderRouter(
    () => ({
      execute: async (operation) => {
        if (operation === "address_name")
          return ok(createAnalysisExecution("entry", identity));
        if (operation === "resolve_containing_procedure")
          return ok(
            createAnalysisExecution(
              {
                query_address: "0x100",
                found: true,
                procedure: {
                  address: "0x100",
                  name: facets.procedureName,
                  classification: null,
                  body: { available: false, reason: "not recorded" },
                },
              },
              identity,
            ),
          );
        if (operation === "comment" || operation === "inline_comment") {
          const text = facets[operation];
          if (text !== undefined)
            return ok(createAnalysisExecution(text, identity));
        }
        return err(
          new AnalysisCapabilityUnavailableError(
            identity.id,
            operation,
            "not provided",
          ),
        );
      },
      close: async () => ok(null),
    }),
    {
      resolveAnalysisProfile: async () =>
        ok({ profile: createAnalysisProfile(identity, { fixture: true }) }),
    },
  );
  const records = new InvestigationRecords({
    maximumRepresentationBytes: 8000,
  });
  const session = new BinarySession(router, records);
  ownArtifactSession(session, onTestFinished);
  const client = await mcp.connect(
    createServer(
      { kind: "session", session },
      { environment: { ...process.env, ...environment } },
    ),
    { name: "context-capacity", version: "1" },
  );
  const definitions = new Map(
    (await client.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  const call = (name: string, args: Record<string, string>) => {
    const toolDefinition = definitions.get(name);
    if (toolDefinition === undefined)
      throw new Error(`Tool ${name} was not advertised`);
    return client.callTool(
      { name, arguments: args },
      { toolDefinition: withCanonicalOutputSchema(toolDefinition) },
    );
  };
  expect(
    (
      await call("open_binary", {
        path: target,
        format: "dos-com",
        provider_id: "fixture",
      })
    ).isError,
  ).not.toBe(true);
  const address = { document: "fixture", address: "0x100" };
  const response = await call("inspect_address_context", address);
  expect(response.isError).not.toBe(true);
  return { client, call, address, response, session, records };
};

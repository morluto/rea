import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect } from "vitest";
import { z } from "zod";
import { jsonObjectSchema } from "../../src/domain/jsonValue.js";
import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../fixtures/analysisView.js";
import {
  environmentStateServeFixture,
  writeEnvironmentServeFiles,
} from "../fixtures/environmentServe.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { startListeningProcess } from "../support/mcp/streamableHttpProcess.js";
import { processTest } from "../support/process/processFixture.js";

const rowsWithClocks = (
  mode: "sparse" | "complete" | "no-clock",
): TimedCaptureRow[] => {
  const members = ["24", "25", "26"].map((suffix, index) => ({
    id: `6ad47b491023b500010871${suffix}`,
    name: ["Delta", "Alpha", "Charlie"][index]!,
    ...(mode === "complete" || (mode === "sparse" && index === 0)
      ? {
          created_at: `2026-10-01T${String(9 + index).padStart(2, "0")}:00:00Z`,
        }
      : {}),
  }));
  const created = {
    id: "6ad47b491023b50001087130",
    name: "Echo",
    ...(mode === "no-clock" ? {} : { created_at: "2026-10-17T18:00:04Z" }),
  };
  return [
    ["GET", "/api/items", members],
    ...members.map((member): TimedCaptureRow => [
      "GET",
      `/api/items/${member.id}`,
      member,
    ]),
    ["POST", "/api/items", created, 201, { name: "Echo" }],
    ["GET", `/api/items/${created.id}`, created],
  ];
};

const sortedCreatedItems = async (client: Client): Promise<void> => {
  for (const name of ["First new item", "Second new item", "Third new item"]) {
    const created = await client.callTool({
      name: "post_items",
      arguments: { body: { name } },
    });
    expect(created.isError).toBeFalsy();
  }
  const reply = await client.callTool({ name: "get_items", arguments: {} });
  expect(reply.isError).toBeFalsy();
  const items = z
    .array(z.object({ id: z.string() }))
    .parse(jsonObjectSchema.parse(reply.structuredContent).body);
  expect(items).toHaveLength(6);
  const ids = items.map(({ id }) => id);
  expect(ids).toEqual([...ids].sort());
};

for (const mode of ["sparse", "complete", "no-clock"] as const)
  processTest(
    `keeps ID-sorted writes with ${mode} creation clocks over HTTP MCP`,
    async ({ processes }) => {
      const fixture = environmentStateServeFixture(
        timedCaptureEvidence(rowsWithClocks(mode)),
      );
      expect(fixture.state.normalized_result).toMatchObject({
        writes: expect.arrayContaining([
          expect.objectContaining({
            tool: "post_items",
            served: true,
            insert: { rule: "sorted", field: "id", direction: "ascending" },
          }),
        ]),
      });
      const root = await createTestTempDirectory("rea-sparse-clock-writes-");
      const files = await writeEnvironmentServeFiles(root, fixture);
      const started = await startListeningProcess(processes, [
        "environment-serve",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        "--port",
        "0",
      ]);
      const client = new Client({ name: "sparse-clock-writes", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(started.url));
        await sortedCreatedItems(client);
      } finally {
        await client.close();
      }
    },
  );

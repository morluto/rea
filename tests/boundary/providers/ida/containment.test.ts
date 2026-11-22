import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectAddressContext } from "../../../../src/application/AnalysisContextQueries.js";
import { EnhancedTools } from "../../../../src/application/EnhancedTools.js";
import { IdaSessionClient } from "../../../../src/ida/IdaSessionClient.js";
import { createIdaTarget, RecordingIdaMcp } from "../../../fixtures/idaMcp.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const session = async (cappedReferences = false) => {
  const { root, target } = await createIdaTarget("arm64");
  roots.push(root);
  const producer = new RecordingIdaMcp(target, "headless");
  if (cappedReferences) {
    const inner = producer.overrideCall;
    producer.overrideCall = (name, args) =>
      name === "xrefs_to"
        ? [
            {
              xrefs: [
                {
                  addr: "0x1004",
                  type: "code",
                  fn: { addr: "0x1000", name: "main", size: "0x20" },
                },
              ],
              more: true,
            },
          ]
        : inner?.(name, args);
  }
  const client = new IdaSessionClient(
    {
      command: "fixture",
      args: [],
      env: {},
      mode: "headless",
      protocol: "modern",
      timeoutMs: 1000,
      workspaceRoot: root,
    },
    target,
    producer,
  );
  return { client, target };
};

const MAIN = {
  found: true,
  procedure: { address: "0x1000", name: "main" },
};

describe("trace_feature on headless IDA", () => {
  it.each([
    { label: "complete", capped: false, residual: [] },
    {
      label: "truncated",
      capped: true,
      residual: [
        "References to 0x3000 were truncated by the provider; additional references may exist.",
      ],
    },
  ])(
    "attributes a reference and reports $label coverage",
    async ({ capped, residual }) => {
      const { client } = await session(capped);
      try {
        const result = await new EnhancedTools(client).execute(
          "trace_feature",
          {
            query: "a.b",
          },
        );

        if (!result.ok) throw result.error;
        expect(result.value).toMatchObject({
          matches: [{ type: "string", address: "0x3000" }],
          references: [
            {
              target_address: "0x3000",
              source_address: "0x1004",
              containing_procedure: MAIN,
            },
          ],
          truncated: capped,
          residual_unknowns: residual,
        });
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );
});

describe("inspect_address_context on headless IDA", () => {
  it.each([
    {
      label: "discovered",
      explicit: false,
      selection: ["current_document", "list_documents"],
    },
    { label: "explicit", explicit: true, selection: [] },
  ])(
    "reports the containing procedure in the $label document",
    async ({ explicit, selection }) => {
      const { client, target } = await session();
      const execute = vi.spyOn(client, "execute");
      try {
        const result = await inspectAddressContext(client, {
          address: "0x1004",
          ...(explicit ? { document: target.path } : {}),
        });

        if (!result.ok) throw result.error;
        expect(result.value).toMatchObject({
          address: "0x1004",
          document: target.path,
          procedure: { state: "available", value: MAIN },
          name: { state: "unavailable" },
          comment: { state: "unavailable" },
          inline_comment: { state: "unavailable" },
          bookmarks: { state: "unavailable" },
        });
        const documentReads = execute.mock.calls
          .map(([operation]) => operation)
          .filter(
            (operation) =>
              operation === "current_document" ||
              operation === "list_documents",
          );
        expect(documentReads).toEqual(selection);
      } finally {
        execute.mockRestore();
        expect((await client.close()).ok).toBe(true);
      }
    },
  );
});

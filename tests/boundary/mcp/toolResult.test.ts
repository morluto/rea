import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ToolContract } from "../../../src/contracts/toolContracts.js";
import { ok } from "../../../src/domain/result.js";
import { err } from "../../../src/domain/result.js";
import { HopperProcessError } from "../../../src/domain/hopperErrors.js";
import { toCallToolResult } from "../../../src/server/toolResult.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { evidenceResultOf } from "../../../src/contracts/toolOutputSchemas.js";

const contract: ToolContract = {
  name: "provider_neutral_fixture",
  title: "Provider Neutral Fixture",
  description: "Fixture contract for provider-neutral output validation.",
  kind: "enhanced",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  effects: {
    mutatesTarget: false,
    mutatesSession: false,
    writesFilesystem: false,
    launchesProcess: false,
    accessesNetwork: false,
    changesUiState: false,
    mayDiscardData: false,
    idempotent: true,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  examples: [{ title: "Example fixture request", input: {} }],
};

describe("tool result projection", () => {
  it("exposes an actionable adapter code to MCP callers", () => {
    const result = toCallToolResult(err(new HopperProcessError(76)), contract);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "provider_unavailable",
        details: { failure_code: "unsupported_demo_dialog" },
        category: "unavailable",
      },
    });
  });
  it("projects bounded private-display coordinates without raw stderr", () => {
    const result = toCallToolResult(
      err(
        new HopperProcessError(80, {
          component: "hopper_private_display",
          operation: "launch",
          status: "error",
          failure_code: "x11_socket_directory_unusable",
          reason: "socket_directory_read_only",
          socket_directory: "/tmp/.X11-unix",
          socket_directory_mode: "0777",
          mount_read_only: true,
          effective_socket_directory_mode: "1777",
          effective_mount_read_only: false,
          wsl: true,
          strategy: "user-mount-namespace",
          fallback_reason: null,
          xvfb_stderr_bytes: 512,
        }),
      ),
      contract,
    );
    expect(result.structuredContent).toMatchObject({
      error: {
        details: {
          failure_code: "x11_socket_directory_unusable",
          diagnostics: {
            socket_directory: "/tmp/.X11-unix",
            mount_read_only: true,
            wsl: true,
            strategy: "user-mount-namespace",
          },
        },
      },
    });
  });
  it("returns result and complete Evidence context in one call", () => {
    const evidence = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "fixture",
        parameters: {},
        result: { value: "observed" },
      },
    );
    const evidenceContract: ToolContract = {
      ...contract,
      outputSchema: evidenceResultOf(z.object({ value: z.string() })),
    };

    const result = toCallToolResult(ok(evidence), evidenceContract);
    expect(result.structuredContent).toMatchObject({
      result: { value: "observed" },
      evidence_id: evidence.evidence_id,
      evidence: {
        normalized_result: { value: "observed" },
        provider: { id: "fixture", name: "Fixture", version: "1" },
        operation: "fixture",
        predicate_type: "rea.analysis",
        parameters: {},
        raw_result: null,
        confidence: "observed",
        authority: "shipped-artifact",
        environment: null,
        limitations: evidence.limitations,
        locations: [],
        evidence_links: [],
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"value":"observed"'),
    });
    const parsed = evidenceContract.outputSchema.parse(
      result.structuredContent,
    );
    expect(parseEvidence(parsed.evidence)).toEqual(evidence);
  });

  it.each<JsonValue>([null, false, 0, "", [], { nested: [false, null, 7] }])(
    "preserves a complete reusable Evidence record for JSON result %j",
    (value) => {
      const evidence = createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        { operation: "fixture", parameters: {}, result: value },
      );
      const evidenceContract = {
        ...contract,
        outputSchema: evidenceResultOf(z.json()),
      };
      const result = toCallToolResult(ok(evidence), evidenceContract);
      const parsed = evidenceContract.outputSchema.parse(
        result.structuredContent,
      );
      expect(parsed.result).toEqual(value);
      expect(parseEvidence(parsed.evidence)).toEqual(evidence);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(parsed) },
      ]);
      const { normalized_result: _missingResult, ...incomplete } = evidence;
      expect(
        evidenceContract.outputSchema.safeParse({
          ...parsed,
          evidence: incomplete,
        }).success,
      ).toBe(false);
    },
  );
});

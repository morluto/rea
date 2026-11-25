import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { expect, it } from "vitest";
import { HopperRegexSearch } from "../../../../src/hopper/HopperRegexSearch.js";
import { HopperRemoteError } from "../../../../src/hopper/HopperErrors.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import {
  HopperFixtureLauncher,
  trackHopperClient,
} from "./hopperClient.fixture.js";

it.each(
  (["search_strings", "search_procedures"] as const).flatMap((operation) =>
    (["capability_unavailable", "bridge_exception"] as const).flatMap(
      (failure) =>
        (["pushdown", "fallback"] as const).map((route) => ({
          operation,
          failure,
          route,
        })),
    ),
  ),
)(
  "attributes real bridge $failure $route response to $operation and preserves wire identity",
  async ({ operation, failure, route }) => {
    const launcher = new HopperFixtureLauncher(
      undefined,
      "quiet",
      "ready",
      "acknowledge",
      failure,
    );
    // Production reply contracts: the inventory reply is validated by the client.
    const client = trackHopperClient(
      new HopperClient({ launcher, startupTimeoutMs: 10_000 }),
    );
    const started = await client.start();
    if (!started.ok) throw started.error;
    const search = new HopperRegexSearch(client);
    const pattern = route === "pushdown" ? "fixture" : "fixture|other";
    const expectedMethod =
      route === "pushdown"
        ? operation
        : operation === "search_strings"
          ? "list_strings"
          : "list_procedures";
    const expectedParams =
      route === "pushdown"
        ? {
            document: "selected-document",
            pattern: "fixture",
            mode: "literal",
            case_sensitive: false,
          }
        : { document: "selected-document" };
    try {
      const result = await search.execute(operation, {
        mode: "regex",
        pattern,
        case_sensitive: false,
        document: "selected-document",
      });
      if (result.ok) throw new Error("Expected fixture failure");
      const request = await launcher.waitForRequest(expectedMethod);
      expect(request.params).toEqual(expectedParams);
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe(
        failure === "capability_unavailable"
          ? "capability_unavailable"
          : "execution_failure",
      );
      expect(projected.details?.operation).toBe(operation);
      expect(result.error.diagnostics).toMatchObject({
        provider_request: {
          operation: expectedMethod,
          request_id: request.id,
          provider_code: -32000,
          diagnostic_type: failure,
        },
      });
      if (failure !== "capability_unavailable") {
        expect(projected.message).toContain(operation);
        expect(result.error.cause).toBeInstanceOf(HopperRemoteError);
        expect(result.error.cause).toMatchObject({
          operation: expectedMethod,
          requestId: request.id,
        });
      }
    } finally {
      await search.close();
      expect((await client.close()).ok).toBe(true);
    }
  },
);

it.each(
  (["search_strings", "search_procedures"] as const).flatMap((operation) =>
    (["pushdown", "fallback"] as const).map((route) => ({ operation, route })),
  ),
)(
  "preserves successful $operation ($route) search and caller-selected document",
  async ({ operation, route }) => {
    const launcher = new HopperFixtureLauncher();
    // Production reply contracts: the inventory reply is validated by the client.
    const client = trackHopperClient(
      new HopperClient({ launcher, startupTimeoutMs: 10_000 }),
    );
    const started = await client.start();
    if (!started.ok) throw started.error;
    const search = new HopperRegexSearch(client);
    const pattern = route === "pushdown" ? "fixture" : "fixture|other";
    const expectedMethod =
      route === "pushdown"
        ? operation
        : operation === "search_strings"
          ? "list_strings"
          : "list_procedures";
    const expectedParams =
      route === "pushdown"
        ? {
            document: "selected-document",
            pattern: "fixture",
            mode: "literal",
            case_sensitive: false,
          }
        : { document: "selected-document" };
    try {
      expect(
        await search.execute(operation, {
          mode: "regex",
          pattern,
          case_sensitive: false,
          document: "selected-document",
        }),
      ).toMatchObject({
        ok: true,
        value: [{ address: "0x1000", value: "fixture" }],
      });
      const request = await launcher.waitForRequest(expectedMethod);
      expect(request.params).toEqual(expectedParams);
    } finally {
      await search.close();
      expect((await client.close()).ok).toBe(true);
    }
  },
);

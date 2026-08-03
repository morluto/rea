import { describe, expect, it } from "vitest";

import {
  getNavigationContext,
  inspectAddressContext,
} from "../../../src/application/AnalysisContextQueries.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
} from "../../../src/domain/errors.js";
import { err, ok } from "../../../src/domain/result.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

describe("analysis context queries: navigation", () => {
  it("aggregates volatile navigation and treats a missing procedure as null", async () => {
    const calls: {
      operation: string;
      parameters: Readonly<Record<string, unknown>>;
    }[] = [];
    const analysis: AnalysisOperationPort = {
      execute: (operation, parameters) => {
        calls.push({ operation, parameters });
        if (operation === "current_document")
          return Promise.resolve(
            ok(createAnalysisExecution("fixture", provider)),
          );
        if (operation === "current_address")
          return Promise.resolve(
            ok(createAnalysisExecution("0x401000", provider)),
          );
        if (operation === "resolve_containing_procedure")
          return Promise.resolve(
            ok(
              createAnalysisExecution(
                {
                  query_address: "0x401000",
                  found: false,
                  procedure: null,
                  reason: "not_in_procedure",
                },
                provider,
              ),
            ),
          );
        return Promise.resolve(
          err(new AnalysisProtocolError(`unexpected ${operation}`)),
        );
      },
    };

    await expect(getNavigationContext(analysis, {})).resolves.toEqual(
      ok({
        document: "fixture",
        address: "0x401000",
        procedure: null,
      }),
    );
    expect(calls).toContainEqual({
      operation: "current_document",
      parameters: {},
    });
    expect(calls).toContainEqual({
      operation: "resolve_containing_procedure",
      parameters: { document: "fixture", address: "0x401000" },
    });
  });

  it("uses an explicit document without passing it to current_document and preserves procedure failures", async () => {
    const calls: string[] = [];
    const failure = new AnalysisProtocolError("provider response malformed");
    const analysis: AnalysisOperationPort = {
      execute: (operation) => {
        calls.push(operation);
        if (operation === "current_address")
          return Promise.resolve(
            ok(createAnalysisExecution("0x401000", provider)),
          );
        return Promise.resolve(err(failure));
      },
    };

    await expect(
      getNavigationContext(analysis, { document: "fixture" }),
    ).resolves.toEqual(err(failure));
    expect(calls).toEqual(["current_address", "resolve_containing_procedure"]);
  });
});

describe("analysis context queries: address facets", () => {
  it("keeps unsupported address facets local and filters bookmarks", async () => {
    const bookmarkInputs: Readonly<Record<string, unknown>>[] = [];
    const analysis: AnalysisOperationPort = {
      execute: (operation, input) => {
        if (operation === "current_document")
          return Promise.resolve(
            ok(createAnalysisExecution("fixture", provider)),
          );
        if (operation === "comment")
          return Promise.resolve(
            err(new AnalysisProtocolError("comments unavailable")),
          );
        switch (operation) {
          case "address_name":
            return Promise.resolve(
              ok(createAnalysisExecution("entry", provider)),
            );
          case "resolve_containing_procedure":
            return Promise.resolve(
              ok(
                createAnalysisExecution(
                  {
                    query_address: "0x401000",
                    found: true,
                    procedure: { address: "0x401000", name: "main" },
                  },
                  provider,
                ),
              ),
            );
          case "inline_comment":
            return Promise.resolve(ok(createAnalysisExecution(null, provider)));
          case "list_bookmarks":
            bookmarkInputs.push(input);
            return Promise.resolve(
              ok(
                createAnalysisExecution(
                  [
                    { address: "0x401000", name: "review" },
                    { address: "0x402000", name: "other" },
                  ],
                  provider,
                ),
              ),
            );
          default:
            return Promise.resolve(
              err(new AnalysisProtocolError(`unexpected ${operation}`)),
            );
        }
      },
    };

    const result = await inspectAddressContext(analysis, {
      address: "401000",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        document: "fixture",
        name: { state: "available", value: "entry" },
        comment: {
          state: "unavailable",
          reason: "comments unavailable",
        },
        bookmarks: {
          state: "available",
          value: [{ address: "0x401000", name: "review" }],
        },
      },
    });
    expect(bookmarkInputs).toEqual([{ document: "fixture" }]);
  });

  it("propagates cancellation instead of degrading it to an unavailable facet", async () => {
    const cancelled = new AnalysisCancelledError("comment");
    const analysis: AnalysisOperationPort = {
      execute: (operation) =>
        Promise.resolve(
          operation === "comment"
            ? err(cancelled)
            : ok(createAnalysisExecution(null, provider)),
        ),
    };

    await expect(
      inspectAddressContext(analysis, {
        address: "0x401000",
        document: "fixture",
      }),
    ).resolves.toEqual(err(cancelled));
  });

  it("reports malformed bookmark output as unavailable instead of empty", async () => {
    const analysis: AnalysisOperationPort = {
      execute: (operation) =>
        Promise.resolve(
          operation === "list_bookmarks"
            ? ok(createAnalysisExecution({ malformed: true }, provider))
            : ok(createAnalysisExecution(null, provider)),
        ),
    };

    await expect(
      inspectAddressContext(analysis, {
        address: "0x401000",
        document: "fixture",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        bookmarks: {
          state: "unavailable",
          reason: expect.stringContaining("malformed"),
        },
      },
    });
  });
});

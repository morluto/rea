import { describe, expect, it } from "vitest";

import { ParseFailureError } from "../domain/parseFailure.js";
import { KunaDocumentError } from "./KunaDocumentError.js";
import { parseKunaJson } from "./KunaJson.js";

const failureOf = (run: () => unknown): KunaDocumentError => {
  try {
    run();
  } catch (cause: unknown) {
    if (cause instanceof KunaDocumentError) return cause;
    throw cause;
  }
  throw new Error("expected a Kuna document failure");
};

describe("Kuna document failures", () => {
  it("reports a document over its buffered allowance as a limit with the caller's maximum", () => {
    const failure = failureOf(() =>
      parseKunaJson('{"address":1}', 4, new Set(["address"])),
    );
    expect(failure).toBeInstanceOf(ParseFailureError);
    expect(failure.code).toBe("buffered_capacity");
    expect(failure.failure).toEqual({
      kind: "limit",
      format: "kuna-document",
      detail: "buffered_capacity",
      limit: { name: "kuna-buffered-document-bytes", maximum: 4 },
    });
  });

  it("reports a non-numeric address as malformed and names its field", () => {
    const failure = failureOf(() =>
      parseKunaJson('{"address":"0x10"}', 1024, new Set(["address"])),
    );
    expect(failure.code).toBe("invalid_address");
    expect(failure.facts).toEqual({ field: "address" });
    expect(failure.failure).toEqual({
      kind: "malformed",
      format: "kuna-document",
      detail: "invalid_address",
      field: "address",
    });
  });
});

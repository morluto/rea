import { describe, expect, it } from "vitest";

import {
  scriptCaptureEvidenceFixture,
  scriptScenarioFixture,
} from "../../../tests/fixtures/webScriptCapture.js";
import { createWebTextArtifact } from "../../domain/webContentArtifact.js";
import { pageScripts } from "./PageScriptCapture.js";
import { selectScriptCapture } from "./ScriptCaptureAdapters.js";

describe("passive script projection", () => {
  it("preserves passive source bytes, declarations, and unavailable languages", () => {
    const artifact = createWebTextArtifact(
      "export const 中文 = '值';",
      "text/javascript",
    );
    const base = {
      script_key: `scr_${"a".repeat(64)}`,
      frame_id: "frame",
      url: "https://a.test/main.js",
      origin: "https://a.test",
      cdp_hash: "cdp-hash",
      length: artifact.text.length,
      is_module: true,
      language: "JavaScript",
      source_map_url: "main.js.map",
      resource_reconciliation: {
        status: "exact",
        resource_key: `res_${"b".repeat(64)}`,
      } as const,
      source: { included: true, artifact } as const,
    };
    const scripts = pageScripts({
      scripts: {
        total: 3,
        items: [
          base,
          { ...base, language: "WebAssembly" },
          { ...base, source: { included: false, reason: "not selected" } },
        ],
      },
    });
    expect(scripts[0]?.content).toMatchObject({
      state: "captured",
      sha256: artifact.sha256,
      bytes: Buffer.from(artifact.text),
      representation: "debugger-source-utf8",
      redacted: null,
    });
    expect(scripts[0]?.source).toMatchObject({
      source_map_url: "main.js.map",
      frame_id: "frame",
    });
    expect(scripts[1]?.content).toMatchObject({
      state: "unavailable",
      reason: "unsupported-language",
    });
    expect(scripts[2]?.content).toMatchObject({
      state: "unavailable",
      message: "not selected",
    });
  });
});

describe("script capture identity and response projection", () => {
  it("joins identical URLs by transaction and source event, retaining binary bytes", () => {
    const capture = scriptScenarioFixture([
      {
        url: "https://fixture.test/main.js",
        bytes: Buffer.from([255, 0, 254]),
      },
      { url: "https://fixture.test/main.js", bytes: Buffer.from("second") },
    ]);
    capture.events.items.reverse();
    const scripts = selectScriptCapture(capture).scripts;
    expect(scripts[0]?.content).toMatchObject({ bytes: Buffer.from("second") });
    expect(scripts[1]?.content).toMatchObject({
      bytes: Buffer.from([255, 0, 254]),
    });
    expect(scripts[0]?.source).toMatchObject({
      transaction_id: "request-2",
      response_sequence: 5,
    });
  });

  it("keeps a metadata-only script request explicitly unavailable", () => {
    const capture = scriptScenarioFixture();
    capture.events.items = capture.events.items.filter(
      ({ kind }) => kind !== "network-content",
    );
    capture.events.retained = capture.events.items.length;
    expect(selectScriptCapture(capture).scripts[0]?.content).toMatchObject({
      state: "unavailable",
      reason: "response-content-not-retained",
    });
  });

  it("authenticates saved Evidence and rejects changed result bytes", () => {
    const evidence = scriptCaptureEvidenceFixture();
    expect(selectScriptCapture(evidence).sourceEvidenceId).toBe(
      evidence.evidence_id,
    );
    expect(() =>
      selectScriptCapture({
        ...evidence,
        normalized_result: scriptScenarioFixture([]),
      }),
    ).toThrow("semantic identifier");
  });

  it("rejects invalid content digests before publication", () => {
    const capture = scriptScenarioFixture();
    const content = capture.events.items.find(
      ({ kind }) => kind === "network-content",
    );
    if (
      content?.kind !== "network-content" ||
      content.body.state !== "captured"
    )
      throw new Error("Missing fixture body");
    content.body.sha256 = "0".repeat(64);
    expect(() => selectScriptCapture(capture)).toThrow("Expected a valid");
  });

  it("refuses to select one byte source from duplicate transaction identities", () => {
    const capture = scriptScenarioFixture();
    const request = capture.events.items[0];
    if (request?.kind !== "request") throw new Error("Missing request");
    capture.events.items.push({ ...request, sequence: 4 });
    capture.events.retained = 4;
    expect(selectScriptCapture(capture).scripts[0]?.source).toMatchObject({
      response_sequence: null,
      status: null,
    });
    expect(
      selectScriptCapture(capture).scripts.every(
        ({ content }) =>
          content.state === "unavailable" &&
          content.reason === "ambiguous-transaction",
      ),
    ).toBe(true);
  });

  it("retains declared redaction and rejects an unexpected response representation", () => {
    const capture = scriptScenarioFixture();
    const content = capture.events.items.find(
      ({ kind }) => kind === "network-content",
    );
    if (
      content?.kind !== "network-content" ||
      content.body.state !== "captured"
    )
      throw new Error("Missing response bytes");
    content.body.redacted = true;
    expect(selectScriptCapture(capture).scripts[0]?.content).toMatchObject({
      state: "captured",
      redacted: true,
    });
    content.body.representation = "browser-exposed-request-bytes";
    expect(selectScriptCapture(capture).scripts[0]?.content).toMatchObject({
      state: "unavailable",
      reason: "unsupported-body-representation",
      message: expect.stringContaining("browser-exposed-request-bytes"),
    });
  });

  it("does not join legacy metadata by URL when transaction identity is absent", () => {
    const capture = scriptScenarioFixture();
    capture.events.items = capture.events.items.filter(
      ({ kind }) => kind !== "network-content",
    );
    for (const event of capture.events.items)
      if (event.kind === "request" || event.kind === "response")
        delete event.transaction_id;
    capture.events.retained = capture.events.items.length;
    expect(selectScriptCapture(capture).scripts[0]).toMatchObject({
      source: { transaction_id: null },
      content: {
        state: "unavailable",
        reason: "transaction-identity-unavailable",
      },
    });
  });
});

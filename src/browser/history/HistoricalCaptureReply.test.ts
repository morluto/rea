import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { historicalHar } from "../../../tests/fixtures/historicalHar.js";
import { decodeHarCapture } from "./HarCapture.js";
import { readHistoricalCaptureReply } from "./HistoricalCaptureReply.js";

const replyFile = async (bytes: Uint8Array) => {
  const root = await createTestTempDirectory("rea-capture-reply-utf8-");
  const path = join(root, "reply.json");
  await writeFile(path, bytes);
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  return { path, resources };
};

const replyText = (kind: "error" | "output", text: string) => {
  if (kind === "error")
    return JSON.stringify({
      ok: false,
      reason: "format",
      message: text,
      pointer: "",
    });
  const capture = historicalHar();
  capture.log.entries[0]!.response.content.text = text;
  return JSON.stringify({
    ok: true,
    value: decodeHarCapture(JSON.stringify(capture), []),
  });
};

it.each(["error", "output"] as const)(
  "rejects malformed bytes inside an otherwise schema-valid %s reply",
  async (kind) => {
    const text = replyText(kind, "WIRE_MARKER");
    const offset = text.indexOf("WIRE_MARKER");
    expect(offset).toBeGreaterThan(0);
    const bytes = Buffer.concat([
      Buffer.from(text.slice(0, offset)),
      Buffer.from([0xff]),
      Buffer.from(text.slice(offset + "WIRE_MARKER".length)),
    ]);
    const file = await replyFile(bytes);
    await expect(
      readHistoricalCaptureReply(file.path, "/capture.har", file.resources),
    ).rejects.toMatchObject({
      _tag: "AnalysisOutputError",
      reason: expect.stringContaining("Reply is not valid UTF-8."),
      cause: { code: "ERR_ENCODING_INVALID_ENCODED_DATA" },
    });
  },
);

it.each(["error", "output"] as const)(
  "preserves valid replacement-character text and exact byte counts in %s replies",
  async (kind) => {
    const text = replyText(kind, "valid � 雪");
    const bytes = Buffer.from(text);
    const file = await replyFile(bytes);
    const result = await readHistoricalCaptureReply(
      file.path,
      "/capture.har",
      file.resources,
    );
    expect(result.bytes).toBe(bytes.length);
    expect(result.finalization).toBeUndefined();
    expect(result.value).toEqual(JSON.parse(text));
  },
);

it.each(["{broken", "\uFEFF{}"])(
  "retains malformed JSON handling for %j",
  async (text) => {
    const file = await replyFile(Buffer.from(text));
    await expect(
      readHistoricalCaptureReply(file.path, "/capture.har", file.resources),
    ).rejects.toMatchObject({
      _tag: "AnalysisOutputError",
      reason: expect.stringContaining("Reply is malformed JSON."),
      cause: expect.any(SyntaxError),
    });
  },
);

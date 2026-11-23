import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../../resources/ArtifactResourceScope.js";
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

it("preserves valid replacement-character text and rejects invalid bytes in the same capture reply", async () => {
  const capture = historicalHar();
  capture.log.entries[0]!.response.content.text = "valid � 雪";
  const reply = {
    ok: true,
    value: decodeHarCapture(JSON.stringify(capture), []),
  };
  const bytes = Buffer.from(JSON.stringify(reply));
  const file = await replyFile(bytes);
  const result = await readHistoricalCaptureReply(
    file.path,
    "/capture.har",
    file.resources,
  );
  expect(result.bytes).toBe(bytes.length);
  expect(result.finalization).toBeUndefined();
  expect(result.value).toEqual(reply);

  const invalid = Buffer.from(bytes);
  const offset = invalid.indexOf(Buffer.from("�"));
  expect(offset).toBeGreaterThan(0);
  invalid[offset] = 0xff;
  await writeFile(file.path, invalid);
  await expect(
    readHistoricalCaptureReply(file.path, "/capture.har", file.resources),
  ).rejects.toMatchObject({
    _tag: "AnalysisOutputError",
    reason: expect.stringContaining("Reply is not valid UTF-8."),
    cause: { code: "ERR_ENCODING_INVALID_ENCODED_DATA" },
  });
});

it.each([
  { text: "{broken", reason: "Reply is malformed JSON.", cause: SyntaxError },
  { text: "\uFEFF{}", reason: "Reply is malformed JSON.", cause: SyntaxError },
  {
    text: '{"ok":true,"value":{}}',
    reason: "Reply violates its schema",
    cause: Error,
  },
])("retains $reason for %j", async ({ text, reason, cause }) => {
  const file = await replyFile(Buffer.from(text));
  await expect(
    readHistoricalCaptureReply(file.path, "/capture.har", file.resources),
  ).rejects.toMatchObject({
    _tag: "AnalysisOutputError",
    reason: expect.stringContaining(reason),
    cause: expect.any(cause),
  });
});

it("preserves native number sidecars until their plain or exponential spelling is marked sensitive", async () => {
  const payload = decodeHarCapture(JSON.stringify(historicalHar()), []);
  const record = payload.records[0]!;
  record.reported = {
    metadata: {
      ["__proto__"]: { ["ratio/~"]: [1e-7, 1e20] },
      ordinary: 42,
    },
  };
  record.numeric_literals = ["1e-07", "1e+20"].map((literal, index) => ({
    pointer: `/metadata/__proto__/ratio~1~0/${index}`,
    producer_type: "float",
    literal,
  }));
  const reply = { ok: true, value: payload };
  const bytes = Buffer.from(JSON.stringify(reply));
  const file = await replyFile(bytes);
  const unmarked = await readHistoricalCaptureReply(
    file.path,
    "/capture.mitm",
    file.resources,
    undefined,
    ["unrelated"],
  );
  expect(unmarked.value).toEqual(reply);
  const result = await readHistoricalCaptureReply(
    file.path,
    "/capture.mitm",
    file.resources,
    undefined,
    ["1e-7", "000000"],
  );
  if (!result.value.ok) throw new Error("Expected a capture reply");
  const retained = result.value.value.records[0]!;
  expect(retained.reported).toEqual({
    metadata: { ["__proto__"]: { ["ratio/~"]: [null, null] }, ordinary: 42 },
  });
  expect(retained.numeric_literals).toEqual([]);
  expect(retained.redactions).toEqual([
    {
      pointer: "/metadata/__proto__/ratio~1~0/0",
      reason: "explicit-sensitive-value",
    },
    {
      pointer: "/metadata/__proto__/ratio~1~0/1",
      reason: "explicit-sensitive-value",
    },
  ]);
  expect(JSON.stringify(retained)).not.toMatch(/1e-7|000000/u);
  expect(result.bytes).toBe(bytes.length);
  expect(Reflect.get(Object.prototype, "ratio/~")).toBeUndefined();
});

it("excludes normalized numbers and their sidecars at both projection roots", async () => {
  const payload = decodeHarCapture(JSON.stringify(historicalHar()), []);
  for (const projection of [payload.container, payload.records[0]!]) {
    projection.reported = 1e-7;
    projection.numeric_literals = [
      { pointer: "", producer_type: "float", literal: "1e-07" },
    ];
    projection.redactions = [];
  }
  const file = await replyFile(
    Buffer.from(JSON.stringify({ ok: true, value: payload })),
  );
  const result = await readHistoricalCaptureReply(
    file.path,
    "/capture.mitm",
    file.resources,
    undefined,
    ["1e-7"],
  );
  if (!result.value.ok) throw new Error("Expected a capture reply");
  for (const retained of [
    result.value.value.container,
    result.value.value.records[0]!,
  ]) {
    expect(retained.reported).toBeNull();
    expect(retained.numeric_literals).toEqual([]);
    expect(retained.redactions).toEqual([
      { pointer: "", reason: "explicit-sensitive-value" },
    ]);
  }
});

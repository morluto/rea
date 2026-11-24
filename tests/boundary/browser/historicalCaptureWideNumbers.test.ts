import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { HistoricalCaptureDecoder } from "../../../src/browser/history/HistoricalCaptureDecoder.js";
import { MITMPROXY_CAPTURE_PROVIDER_IDENTITY } from "../../../src/browser/history/CaptureProviderIdentities.js";
import { decodeHarCapture } from "../../../src/browser/history/HarCapture.js";
import { inspectWebNetworkCaptureInputSchema } from "../../../src/domain/webNetworkCapture.js";
import { historicalHar } from "../../fixtures/historicalHar.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains every exclusion in a wide native-number reply through the owned decoder", async () => {
  const root = await createTestTempDirectory("rea-wide-native-numbers-");
  const capturePath = join(root, "capture.mitm");
  const original = "source-owned native decoder input";
  await writeFile(capturePath, original);
  const count = 150_000;
  const payload = decodeHarCapture(JSON.stringify(historicalHar()), []);
  payload.decoder = MITMPROXY_CAPTURE_PROVIDER_IDENTITY;
  payload.container.reported = { normalized: 1e-7, ordinary: "container" };
  payload.container.numeric_literals = [
    { pointer: "/normalized", producer_type: "float", literal: "1e-07" },
  ];
  const record = payload.records[0]!;
  record.location = { kind: "byte-range", offset: 0, bytes: original.length };
  // Python's native projection retains 1e-07; the reply owner must also check
  // the JavaScript spelling 1e-7 before retaining Evidence.
  record.reported = {
    values: Array.from({ length: count }, () => 1e-7),
    ordinary: 42,
    request: { headers: [["authorization", null]] },
  };
  record.binary_fields = [];
  const existingRedaction = {
    pointer: "/request/headers/0/1",
    reason: "transport-credential" as const,
  };
  record.redactions = [existingRedaction];
  record.numeric_literals = Array.from({ length: count }, (_, index) => ({
    pointer: `/values/${String(index)}`,
    producer_type: "float" as const,
    literal: "1e-07",
  }));
  const ordinary = {
    pointer: "/ordinary",
    producer_type: "integer" as const,
    literal: "42",
  };
  record.numeric_literals.push(ordinary);
  const replyPath = join(root, "producer-reply.json");
  await writeFile(replyPath, JSON.stringify({ ok: true, value: payload }));
  const decoder = new HistoricalCaptureDecoder(
    [
      {
        format: "mitmproxy",
        identity: MITMPROXY_CAPTURE_PROVIDER_IDENTITY,
        command: async (_, runtime) => ({
          command: process.execPath,
          arguments: [
            "-e",
            "require('node:fs').copyFileSync(process.argv[1], process.argv[2])",
            replyPath,
            join(runtime, "reply.json"),
          ],
        }),
      },
    ],
    process.env,
  );
  onTestFinished(() => decoder.close());
  for (const marked of [false, true]) {
    const result = await decoder.inspect(
      inspectWebNetworkCaptureInputSchema.parse({
        capture_path: capturePath,
        format: "mitmproxy",
        sensitive_values: marked ? ["1e-7"] : [],
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.artifact.sha256).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    expect(result.value.container.reported).toEqual({
      normalized: marked ? null : 1e-7,
      ordinary: "container",
    });
    expect(result.value.container.numeric_literals).toEqual(
      marked ? [] : payload.container.numeric_literals,
    );
    const retained = result.value.records[0]!;
    expect(retained.location).toEqual(record.location);
    expect(retained.reported).toMatchObject({
      ordinary: 42,
      request: { headers: [["authorization", null]] },
    });
    const values = (retained.reported as { values: unknown[] }).values;
    expect(values).toHaveLength(count);
    expect(values.every((value) => value === (marked ? null : 1e-7))).toBe(
      true,
    );
    expect(retained.numeric_literals).toEqual(
      marked ? [ordinary] : record.numeric_literals,
    );
    expect(retained.redactions[0]).toEqual(existingRedaction);
    expect(retained.redactions).toHaveLength(marked ? count + 1 : 1);
    if (marked)
      expect(
        retained.redactions
          .slice(1)
          .every(
            (redaction, index) =>
              redaction.pointer === `/values/${String(index)}` &&
              redaction.reason === "explicit-sensitive-value",
          ),
      ).toBe(true);
    expect(await readFile(capturePath, "utf8")).toBe(original);
  }
});

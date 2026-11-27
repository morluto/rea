import { expect, it } from "vitest";
import { MAX_APKTOOL_DECODE_OUTPUT_BYTES } from "../domain/apktool/apktoolResourceAnalysis.js";
import {
  DEFAULT_ASSETUTIL_OUTPUT_BYTES,
  MAX_ASSETUTIL_OUTPUT_BYTES,
} from "../domain/apple/appleAssetCatalog.js";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  producerOutputBytesLimit,
  resolveProducerOutputBytes,
} from "./producerOutputBytes.js";

const ceilings = [
  {
    name: "apktool",
    defaultValue: 4 * 1024 * 1024,
    maximum: MAX_APKTOOL_DECODE_OUTPUT_BYTES,
  },
  {
    name: "assetutil",
    defaultValue: DEFAULT_ASSETUTIL_OUTPUT_BYTES,
    maximum: MAX_ASSETUTIL_OUTPUT_BYTES,
  },
] as const;

it.each(ceilings)(
  "clamps a runtime $name output setting above the producer maximum",
  ({ defaultValue, maximum }) => {
    const above = maximum + 1;
    const resolved = runWithAnalysisOperationSnapshot(
      { revision: 1, overrides: { "producer.output_bytes": above } },
      () =>
        resolveProducerOutputBytes(undefined, {}, { defaultValue, maximum }),
    );
    expect(resolved).toEqual({
      ok: true,
      value: { value: maximum, source: "runtime" },
    });
    if (!resolved.ok) return;
    expect(producerOutputBytesLimit(resolved.value, maximum)).toMatchObject({
      setting: "producer.output_bytes",
      effective_value: maximum,
      source: "runtime",
      maximum,
    });
  },
);

it.each(ceilings)(
  "clamps a $name REA_PRODUCER_OUTPUT_BYTES seed above the producer maximum",
  ({ defaultValue, maximum }) => {
    const resolved = resolveProducerOutputBytes(
      undefined,
      { REA_PRODUCER_OUTPUT_BYTES: String(maximum + 1) },
      { defaultValue, maximum },
    );
    expect(resolved).toEqual({
      ok: true,
      value: { value: maximum, source: "setting" },
    });
    if (!resolved.ok) return;
    expect(producerOutputBytesLimit(resolved.value, maximum)).toMatchObject({
      setting: "producer.output_bytes",
      effective_value: maximum,
      source: "setting",
      maximum,
    });
  },
);

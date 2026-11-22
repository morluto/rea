import { expect, it } from "vitest";

import { analysisSettingDefinition } from "../domain/analysisSettingDefinitions.js";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import { GHIDRA_OPERATIONS } from "../ghidra/GhidraProviderMetadata.js";
import { HOPPER_OPERATIONS } from "../hopper/HopperProviderMetadata.js";
import {
  BRIDGE_MAX_REPLY_BYTES_SETTING,
  DEFAULT_BRIDGE_MAX_REPLY,
} from "./bridgeMaxReplyBytes.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { parseConfig } from "./parseConfig.js";
import { runtimeAnalysisConfig } from "./runtimeAnalysisSettings.js";

it("advertises the reply ceiling for every Hopper and Ghidra operation", () => {
  const advertised = new Set(
    analysisSettingDefinition("bridge.max_reply_bytes").operations,
  );
  expect(
    [...HOPPER_OPERATIONS, ...GHIDRA_OPERATIONS].filter(
      (operation) => !advertised.has(operation),
    ),
  ).toEqual([]);
});

it("resolves the default, a launch seed, and a runtime override", () => {
  const unset = parseConfig({});
  if (!unset.ok) throw unset.error;
  expect(unset.value.bridgeMaxReplyBytes).toEqual(DEFAULT_BRIDGE_MAX_REPLY);

  const seeded = parseConfig({ [BRIDGE_MAX_REPLY_BYTES_SETTING]: "2097152" });
  if (!seeded.ok) throw seeded.error;
  expect(seeded.value.bridgeMaxReplyBytes).toEqual({
    maximumBytes: 2_097_152,
    source: "setting",
  });

  const runtime = runtimeAnalysisConfig(seeded.value);
  runWithAnalysisOperationSnapshot(
    { revision: 1, overrides: { "bridge.max_reply_bytes": 4_194_304 } },
    () => {
      expect({ ...runtime.bridgeMaxReplyBytes }).toEqual({
        maximumBytes: 4_194_304,
        source: "runtime",
      });
    },
  );
});

it("rejects a launch seed below the floor when the ceiling is read", () => {
  const parsed = parseConfig({ [BRIDGE_MAX_REPLY_BYTES_SETTING]: "1024" });
  if (!parsed.ok) throw parsed.error;
  const runtime = runtimeAnalysisConfig(parsed.value);
  expect(() => runtime.bridgeMaxReplyBytes.maximumBytes).toThrow(
    ConfigurationError,
  );
});

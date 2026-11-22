import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import {
  analysisSettingDefinition,
  analysisSettingIds,
} from "../domain/analysisSettingDefinitions.js";
import { ADVERTISED_INPUT_SCHEMA_MAX_BYTES } from "./advertisedDialect.js";
import { ANALYSIS_SETTINGS_TOOL_CONTRACTS } from "./analysisSettingsContracts.js";
import { compactAdvertisedInputSchema } from "./compactInputSchema.js";
import { ELECTRON_TOOL_CONTRACTS } from "./javascript/electronToolContracts.js";
import {
  advertisedInputJsonSchema,
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "./toolSchemaMetadata.js";
import { APPLICATION_TOOL_CONTRACTS } from "./applicationToolContracts.js";

// Each MCP server registers every contract. The SDK reprojects registered
// schemas on every tools/list, so a wrapper rebuilt per server would repeat
// the whole catalog's JSON Schema conversion for each new server.
it("shares one advertised wrapper and projection per contract across registrations", () => {
  const contract = ELECTRON_TOOL_CONTRACTS.find(
    ({ name }) => name === "analyze_javascript_application",
  );
  if (contract === undefined) throw new Error("Missing contract fixture");
  const options = { target: "draft-2020-12" } as const;

  const firstInput = toolInputSchemaWithMetadata(contract);
  const secondInput = toolInputSchemaWithMetadata(contract);
  expect(secondInput).toBe(firstInput);
  expect(secondInput["~standard"].jsonSchema.input(options)).toBe(
    firstInput["~standard"].jsonSchema.input(options),
  );

  const firstOutput = toolOutputSchemaWithMetadata(contract);
  const secondOutput = toolOutputSchemaWithMetadata(contract);
  expect(secondOutput).toBe(firstOutput);
  expect(secondOutput["~standard"].jsonSchema.output(options)).toBe(
    firstOutput["~standard"].jsonSchema.output(options),
  );
});

it("declares an object root only on the advertised output of an object union", () => {
  const contract = APPLICATION_TOOL_CONTRACTS.find(
    ({ name }) => name === "guided_workflows",
  );
  if (contract === undefined) throw new Error("Missing guided_workflows");
  const advertised = toolOutputSchemaWithMetadata(contract)[
    "~standard"
  ].jsonSchema.output({ target: "draft-2020-12" });
  expect(advertised).toMatchObject({ type: "object" });
  expect(advertised).toHaveProperty("oneOf");
  // The canonical projection keeps only what parsing enforces.
  expect(z.toJSONSchema(contract.outputSchema)).not.toHaveProperty("type");
});

it("keeps update_analysis_settings compact advertised input inline under the depth cap", () => {
  const contract = ANALYSIS_SETTINGS_TOOL_CONTRACTS.find(
    ({ name }) => name === "update_analysis_settings",
  );
  if (contract === undefined)
    throw new Error("Missing update_analysis_settings contract");
  const canonical = advertisedInputJsonSchema(contract);
  const compacted = compactAdvertisedInputSchema(
    canonical,
    ADVERTISED_INPUT_SCHEMA_MAX_BYTES,
  );
  expect(compacted.presentation).toBe("inline");
  const validate = new Ajv2020({ strict: false }).compile(compacted.schema);
  for (const setting of analysisSettingIds) {
    const { minimum } = analysisSettingDefinition(setting);
    expect(
      validate({ changes: [{ setting, action: "set", value: minimum }] }),
      `set ${setting}`,
    ).toBe(true);
    expect(
      validate({ changes: [{ setting, action: "reset" }] }),
      `reset ${setting}`,
    ).toBe(true);
    expect(
      validate({ changes: [{ setting, action: "set", value: "invalid" }] }),
      `set ${setting} with a string`,
    ).toBe(false);
  }
  expect(
    validate({ changes: [{ setting: "unknown.setting", action: "reset" }] }),
  ).toBe(false);
});

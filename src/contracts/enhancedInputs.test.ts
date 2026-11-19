import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  enhancedInputSchemas,
  MAX_ENHANCED_RECORDS,
} from "./enhancedInputs.js";
import { advertisedInputJsonSchema } from "./toolSchemaMetadata.js";
import { toolContract } from "./toolContracts.js";

describe("batch_decompile input contract", () => {
  it("bounds addresses in the canonical and advertised schemas", () => {
    const addresses = Array.from({ length: MAX_ENHANCED_RECORDS }, () => "0x0");
    const schema = enhancedInputSchemas.batch_decompile;
    expect(schema.safeParse({ addresses }).success).toBe(true);
    expect(schema.safeParse({ addresses: [...addresses, "0x1"] }).success).toBe(
      false,
    );

    const advertised = advertisedInputJsonSchema(
      toolContract("batch_decompile"),
    );
    const advertisedAddresses = (
      advertised.properties as Record<string, unknown>
    ).addresses;
    expect(advertisedAddresses).toMatchObject({
      type: "array",
      maxItems: MAX_ENHANCED_RECORDS,
    });

    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(advertised)).toBe(true);
    const validate = ajv.compile(advertised);
    expect(validate({ addresses })).toBe(true);
    expect(validate({ addresses: [...addresses, "0x1"] })).toBe(false);
  });
});

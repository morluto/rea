import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS, toolContract } from "./toolContracts.js";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "./toolSchemaMetadata.js";

const target = "draft-2020-12";

describe("advertised tool JSON Schema", () => {
  it("keeps examples and output schemas aligned with canonical contracts", () => {
    for (const contract of TOOL_CONTRACTS) {
      const input = toolInputSchemaWithMetadata(contract)["~standard"];
      const output = toolOutputSchemaWithMetadata(contract)["~standard"];
      const advertisedInput = input.jsonSchema.input({ target });
      const advertisedOutput = output.jsonSchema.output({ target });

      expect(advertisedInput.examples, contract.name).toEqual(
        contract.examples.map(({ input: example }) => example),
      );
      expect(advertisedOutput, contract.name).toEqual(
        contract.outputSchema["~standard"].jsonSchema.output({ target }),
      );
    }
  });

  it("keeps other targets and library options distinct", () => {
    const contract = toolContract("open_binary");
    const input = toolInputSchemaWithMetadata(contract)["~standard"];
    const latest = input.jsonSchema.input({ target });
    const draft07 = input.jsonSchema.input({ target: "draft-07" });

    expect(latest.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(draft07.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});

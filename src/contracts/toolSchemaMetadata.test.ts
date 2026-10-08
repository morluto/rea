import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS, toolContract } from "./toolContracts.js";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "./toolSchemaMetadata.js";

const target = "draft-2020-12";

describe("advertised tool JSON Schema", () => {
  it("projects each canonical contract once per target", () => {
    for (const contract of TOOL_CONTRACTS) {
      const input = toolInputSchemaWithMetadata(contract)["~standard"];
      const output = toolOutputSchemaWithMetadata(contract)["~standard"];
      const advertisedInput = input.jsonSchema.input({ target });
      const advertisedOutput = output.jsonSchema.output({ target });

      expect(input.jsonSchema.input({ target }), contract.name).toBe(
        advertisedInput,
      );
      expect(output.jsonSchema.output({ target }), contract.name).toBe(
        advertisedOutput,
      );
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
    const libraryOptions = { unrepresentable: "any" };
    const configured = input.jsonSchema.input({ target, libraryOptions });

    expect(latest.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(draft07.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(input.jsonSchema.input({ target: "draft-07" })).toBe(draft07);
    expect(configured).not.toBe(latest);
    expect(input.jsonSchema.input({ target, libraryOptions })).not.toBe(
      configured,
    );
    expect(
      toolInputSchemaWithMetadata(contract).safeParse(
        contract.examples[0]?.input,
      ).success,
    ).toBe(true);
  });
});

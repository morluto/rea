import { describe, expect, it } from "vitest";

import { inlineLocalJsonSchemaReferences } from "../../tests/fixtures/localJsonSchemaReferences.js";
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
      expect(
        inlineLocalJsonSchemaReferences(advertisedOutput),
        contract.name,
      ).toEqual(
        inlineLocalJsonSchemaReferences(
          contract.outputSchema["~standard"].jsonSchema.output({ target }),
        ),
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

  it("preserves complete output meaning across JSON Schema dialects", () => {
    for (const dialect of ["draft-2020-12", "draft-07"] as const)
      for (const contract of TOOL_CONTRACTS) {
        const advertised = toolOutputSchemaWithMetadata(contract)[
          "~standard"
        ].jsonSchema.output({ target: dialect });
        const canonical = contract.outputSchema["~standard"].jsonSchema.output({
          target: dialect,
        });
        expect(
          inlineLocalJsonSchemaReferences(advertised),
          contract.name,
        ).toEqual(inlineLocalJsonSchemaReferences(canonical));
      }
  });

  it("retains memoization and explicit caller projection options", () => {
    const contract = toolContract("analyze_javascript_application");
    const output =
      toolOutputSchemaWithMetadata(contract)["~standard"].jsonSchema;
    const shared = output.output({ target });
    expect(shared.$defs).toBeDefined();
    expect(output.output({ target })).toBe(shared);
    const options = { target, libraryOptions: { reused: "inline" } };
    const inline = output.output(options);
    expect(inline).toEqual(
      contract.outputSchema["~standard"].jsonSchema.output(options),
    );
    expect(inline.$defs).toBeUndefined();
    expect(output.output({ target })).toBe(shared);
    const draft07 = output.output({ target: "draft-07" });
    expect(draft07.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(inlineLocalJsonSchemaReferences(draft07)).toEqual(
      inlineLocalJsonSchemaReferences(
        contract.outputSchema["~standard"].jsonSchema.output({
          target: "draft-07",
        }),
      ),
    );
    expect(output.output({ target: "draft-07" })).toBe(draft07);
  });
});

import { expect, it } from "vitest";

import { toolContract } from "./toolContracts.js";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "./toolSchemaMetadata.js";

// Each MCP server registers every contract. The SDK reprojects registered
// schemas on every tools/list, so a wrapper rebuilt per server would repeat
// the whole catalog's JSON Schema conversion for each new server.
it("shares one advertised wrapper and projection per contract across registrations", () => {
  const contract = toolContract("analyze_javascript_application");
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

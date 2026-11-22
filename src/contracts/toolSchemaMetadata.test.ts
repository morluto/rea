import { expect, it } from "vitest";
import { z } from "zod";

import { ELECTRON_TOOL_CONTRACTS } from "./javascript/electronToolContracts.js";
import {
  hasGuaranteedObjectOutputRoot,
  omitAdvertisedOutputJsonSchema,
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

it("identifies guaranteed object-root outputs and omits unused output projections safely", async () => {
  const objectContract = ELECTRON_TOOL_CONTRACTS.find(
    ({ name }) => name === "analyze_javascript_application",
  );
  const unionObjectContract = APPLICATION_TOOL_CONTRACTS.find(
    ({ name }) => name === "guided_workflows",
  );
  const nonObjectUnionContract = APPLICATION_TOOL_CONTRACTS.find(
    ({ name }) => name === "search_guidance",
  );
  if (
    objectContract === undefined ||
    unionObjectContract === undefined ||
    nonObjectUnionContract === undefined
  )
    throw new Error("Missing expected contract fixtures");

  expect(
    hasGuaranteedObjectOutputRoot(toolOutputSchemaWithMetadata(objectContract)),
  ).toBe(true);
  expect(
    hasGuaranteedObjectOutputRoot(
      toolOutputSchemaWithMetadata(unionObjectContract),
    ),
  ).toBe(true);
  expect(
    hasGuaranteedObjectOutputRoot(
      toolOutputSchemaWithMetadata(nonObjectUnionContract),
    ),
  ).toBe(false);

  const schema = z.strictObject({ ok: z.literal(true) });
  const originalOutput = schema["~standard"].jsonSchema.output;
  let calls = 0;
  Object.defineProperty(schema, "~standard", {
    value: {
      ...schema["~standard"],
      jsonSchema: {
        ...schema["~standard"].jsonSchema,
        output: (options: unknown) => {
          calls += 1;
          return originalOutput(options as never);
        },
      },
    },
  });
  const omitted = omitAdvertisedOutputJsonSchema(schema);
  expect(
    omitted["~standard"].jsonSchema.output({ target: "draft-2020-12" }),
  ).toEqual({ type: "object" });
  expect(calls).toBe(0);
  expect(omitted["~standard"].validate({ ok: true })).toEqual({
    value: { ok: true },
  });
  expect(omitted["~standard"].validate({ ok: false })).toMatchObject({
    issues: expect.any(Array),
  });
});

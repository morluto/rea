import { expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";

import { advertisedInputJsonSchema } from "../../../src/contracts/toolSchemaMetadata.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { RESERVED_CHECKPOINT_NAMES } from "../../../src/domain/desktop/desktopCapture.js";

it("advertises the checkpoint names the capture keeps for itself", () => {
  // A `.refine` refuses a name only after the caller sends it. A caller choosing
  // a checkpoint name needs the reservation before the request, so the published
  // schema must state it too — otherwise an MCP client validates `baseline`,
  // sends it, and is refused by the server it just checked against.
  const contract = toolContract("mark_build_checkpoint");
  const advertised = advertisedInputJsonSchema(contract);
  const validate = new Ajv2020({
    strict: false,
    logger: false,
    validateFormats: false,
  }).compile(advertised);
  const request = (name: string) => ({
    computer_id: "00000000-0000-4000-8000-000000000000",
    name,
  });

  const refused = [...RESERVED_CHECKPOINT_NAMES];
  expect(refused).toEqual(["baseline", "stop", "time-limit", "exit"]);
  for (const name of refused) {
    expect(contract.inputSchema.safeParse(request(name)).success, name).toBe(
      false,
    );
    expect(validate(request(name)), name).toBe(false);
  }
  for (const name of ["seed", "end", "my-task", "end-task-one"]) {
    expect(contract.inputSchema.safeParse(request(name)).success, name).toBe(
      true,
    );
    expect(validate(request(name)), name).toBe(true);
  }
});

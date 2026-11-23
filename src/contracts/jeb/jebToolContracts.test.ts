import { expect, it } from "vitest";

import { JEB_TOOL_CONTRACTS } from "./jebToolContracts.js";
import { toolContract } from "../toolContracts.js";

it("declares JEB network access and local authority limits", () => {
  for (const contract of JEB_TOOL_CONTRACTS) {
    expect(contract.effects, contract.name).toMatchObject({
      accessesNetwork: true,
      launchesProcess: false,
      writesFilesystem: false,
      mutatesTarget: false,
    });
  }
  expect(toolContract("open_jeb_project").effects.idempotent).toBe(false);
});

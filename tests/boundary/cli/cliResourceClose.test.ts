import { expect, it, vi } from "vitest";
import "../../../src/cli.js";
import {
  CliResourceOwners,
  cliProcessResourceOwners,
} from "../../../src/cli/cliResources.js";

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "settles both CLI owners when JavaScript fails=%s and guidance fails=%s",
  async (jsFails, guideFails) => {
    const jsError = new Error("JavaScript resources retained");
    const guideError = new Error("Guidance descriptor retained");
    const js = vi.fn(async () => {
      if (jsFails) throw jsError;
    });
    const guides = vi.fn(async () => {
      if (guideFails) throw guideError;
    });
    const owners = new CliResourceOwners();
    owners.own("javascript-analysis", js);
    owners.own("guidance", guides);
    const closing = owners.close();
    if (jsFails && guideFails)
      await expect(closing).rejects.toMatchObject({
        errors: [jsError, guideError],
      });
    else if (jsFails || guideFails)
      await expect(closing).rejects.toBe(jsFails ? jsError : guideError);
    else await expect(closing).resolves.toBeUndefined();
    expect(js).toHaveBeenCalledOnce();
    expect(guides).toHaveBeenCalledOnce();
  },
);

it("registers every process-owned CLI resource the complete CLI loads", () => {
  expect(cliProcessResourceOwners()).toEqual(
    expect.arrayContaining([
      "javascript-analysis",
      "guidance",
      "mcp-registration",
    ]),
  );
});

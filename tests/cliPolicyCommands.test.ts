import { describe, expect, it, vi } from "vitest";

import { approvePolicyRevocation } from "../src/cliPolicyCommands.js";

describe("policy revocation approval", () => {
  it("accepts --yes without invoking the interactive prompt", async () => {
    const confirm = vi.fn<() => Promise<boolean>>();

    await expect(
      approvePolicyRevocation({
        approved: true,
        interactive: false,
        grantId: "grant-1",
        confirm,
      }),
    ).resolves.toEqual({ approved: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("fails closed for non-interactive revocation without --yes", async () => {
    const confirm = vi.fn<() => Promise<boolean>>();

    await expect(
      approvePolicyRevocation({
        approved: false,
        interactive: false,
        grantId: "grant-1",
        confirm,
      }),
    ).resolves.toEqual({ approved: false, reason: "required" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    [true, { approved: true }],
    [false, { approved: false, reason: "cancelled" }],
  ] as const)(
    "uses the interactive decision %s",
    async (decision, expected) => {
      const confirm = vi.fn(() => Promise.resolve(decision));

      await expect(
        approvePolicyRevocation({
          approved: false,
          interactive: true,
          grantId: "grant-1",
          confirm,
        }),
      ).resolves.toEqual(expected);
      expect(confirm).toHaveBeenCalledWith("grant-1");
    },
  );
});

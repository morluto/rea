import { expect, it } from "vitest";

import { hopperLoaderArgsForTarget } from "./HopperAnalysisProfile.js";

it("routes physical universal Mach-O containers through Hopper's FAT loader", () => {
  const result = hopperLoaderArgsForTarget(
    {
      path: "/tmp/universal",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "mach-o-universal",
      architecture: "arm64",
      availableArchitectures: ["x86_64", "arm64"],
    },
    "fat64",
  );

  expect(result).toEqual({
    ok: true,
    value: ["-l", "FAT", "--aarch64", "-l", "Mach-O"],
  });
});

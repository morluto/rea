import { describe, expect, it } from "vitest";

import { managedArtifactInputSchema } from "./managed/managedToolContracts.js";
import { exportEvidenceBundleInputSchema } from "./sessionToolContracts.js";
import {
  closeBinaryInputSchema,
  openBinaryInputSchema,
} from "./sessionLifecycleInputs.js";

const openBinaryAbsolute = (snapshot_path: string) =>
  openBinaryInputSchema.safeParse({ path: "/tmp/fixture", snapshot_path });

describe("session snapshot path inputs require absolute local paths", () => {
  it("rejects a relative snapshot path when opening a binary", () => {
    expect(openBinaryAbsolute("relative/analysis.json").success).toBe(false);
  });

  it("rejects a parent-relative snapshot path when opening a binary", () => {
    expect(openBinaryAbsolute("../outside/analysis.json").success).toBe(false);
  });

  it("accepts an absolute snapshot path when opening a binary", () => {
    expect(openBinaryAbsolute("/tmp/rea/analysis.json").success).toBe(true);
  });

  it("still accepts open_binary without a snapshot path", () => {
    expect(
      openBinaryInputSchema.safeParse({ path: "/tmp/fixture" }).success,
    ).toBe(true);
  });

  it("rejects a relative snapshot path when closing a binary", () => {
    expect(
      closeBinaryInputSchema.safeParse({ snapshot_path: "analysis.json" })
        .success,
    ).toBe(false);
  });

  it("accepts an absolute snapshot path when closing a binary", () => {
    expect(
      closeBinaryInputSchema.safeParse({ snapshot_path: "/tmp/analysis.json" })
        .success,
    ).toBe(true);
  });

  it("still accepts close_binary without a snapshot path", () => {
    expect(closeBinaryInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("evidence bundle export path requires an absolute local path", () => {
  it("rejects a relative export path", () => {
    expect(
      exportEvidenceBundleInputSchema.safeParse({ path: "out/bundle.json" })
        .success,
    ).toBe(false);
  });

  it("rejects a parent-relative export path", () => {
    expect(
      exportEvidenceBundleInputSchema.safeParse({
        path: "../../bundle.json",
      }).success,
    ).toBe(false);
  });

  it("accepts an absolute export path and keeps overwrite semantics", () => {
    expect(
      exportEvidenceBundleInputSchema.safeParse({
        path: "/tmp/bundle.json",
      }),
    ).toMatchObject({ success: true, data: { overwrite: false } });
  });
});

describe("managed target path requires an absolute local path", () => {
  it("rejects a relative managed target path", () => {
    expect(
      managedArtifactInputSchema.safeParse({ path: "bin/app.dll" }).success,
    ).toBe(false);
  });

  it("accepts an absolute managed target path", () => {
    expect(
      managedArtifactInputSchema.safeParse({ path: "/tmp/app.dll" }).success,
    ).toBe(true);
  });

  it("still accepts omitting the path to reuse the active target", () => {
    expect(managedArtifactInputSchema.safeParse({}).success).toBe(true);
  });
});

describe.runIf(process.platform === "win32")(
  "windows absolute path forms on windows hosts",
  () => {
    it("accepts drive-letter backslash snapshot paths", () => {
      expect(
        closeBinaryInputSchema.safeParse({
          snapshot_path: "C:\\rea\\analysis.json",
        }).success,
      ).toBe(true);
    });

    it("accepts drive-letter forward-slash snapshot paths", () => {
      expect(
        closeBinaryInputSchema.safeParse({
          snapshot_path: "C:/rea/analysis.json",
        }).success,
      ).toBe(true);
    });

    it("accepts forward-slash export paths", () => {
      expect(
        exportEvidenceBundleInputSchema.safeParse({
          path: "C:/rea/bundle.json",
        }).success,
      ).toBe(true);
    });
  },
);

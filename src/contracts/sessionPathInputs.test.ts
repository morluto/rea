import { describe, expect, it } from "vitest";

import { browserScenarioBrowserSchema } from "../domain/browserScenarioValues.js";
import { firmwareInputSchemas } from "../domain/firmware/firmwareAnalysis.js";
import { electronActiveObservationInputSchema } from "../domain/javascript/electronActiveObservation.js";
import { managedArtifactInputSchema } from "./managed/managedToolContracts.js";
import { exportEvidenceBundleInputSchema } from "./sessionToolContracts.js";
import {
  closeBinaryInputSchema,
  openBinaryInputSchema,
} from "./sessionLifecycleInputs.js";
import { importEvidenceBundleInputSchema } from "./sessionToolSchemas.js";
import { binarySessionInputSchema } from "./sessionStatusContract.js";

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

describe("open binary target path requires an absolute local path", () => {
  it("rejects a relative target path", () => {
    expect(
      openBinaryInputSchema.safeParse({ path: "fixtures/app.bin" }).success,
    ).toBe(false);
  });

  it("accepts an absolute target path", () => {
    expect(
      openBinaryInputSchema.safeParse({ path: "/tmp/fixture.bin" }).success,
    ).toBe(true);
  });
});

describe("evidence bundle import path requires an absolute local path", () => {
  it("rejects a relative bundle path", () => {
    expect(
      importEvidenceBundleInputSchema.safeParse({ path: "evidence.json" })
        .success,
    ).toBe(false);
  });

  it("accepts an absolute bundle path", () => {
    expect(
      importEvidenceBundleInputSchema.safeParse({ path: "/tmp/evidence.json" })
        .success,
    ).toBe(true);
  });
});

describe("firmware input path requires an absolute local path", () => {
  it("rejects a relative firmware path when inspecting regions", () => {
    expect(
      firmwareInputSchemas.inspect_firmware_regions.safeParse({
        path: "firmware.bin",
      }).success,
    ).toBe(false);
  });

  it("rejects a relative firmware path when extracting", () => {
    expect(
      firmwareInputSchemas.extract_firmware.safeParse({
        path: "firmware.bin",
        output_directory: "/tmp/firmware-output",
      }).success,
    ).toBe(false);
  });

  it("accepts an absolute firmware path", () => {
    expect(
      firmwareInputSchemas.inspect_firmware_regions.safeParse({
        path: "/tmp/firmware.bin",
      }).success,
    ).toBe(true);
  });
});

describe("browser executable path requires an absolute local path", () => {
  it("rejects a bare executable name", () => {
    expect(
      browserScenarioBrowserSchema.safeParse({
        mode: "launch",
        executable_path: "chrome",
      }).success,
    ).toBe(false);
  });

  it("accepts an absolute executable path", () => {
    expect(
      browserScenarioBrowserSchema.safeParse({
        mode: "launch",
        executable_path: "/opt/chromium/chrome",
      }).success,
    ).toBe(true);
  });
});

describe("electron observation paths require absolute local paths", () => {
  const valid = {
    executable_path: "/Applications/Electron.app/Contents/MacOS/Electron",
    application_path: "/tmp/electron-app/main.js",
  };

  it("rejects a relative executable path", () => {
    expect(
      electronActiveObservationInputSchema.safeParse({
        ...valid,
        executable_path: "Electron",
      }).success,
    ).toBe(false);
  });

  it("rejects a relative application path", () => {
    expect(
      electronActiveObservationInputSchema.safeParse({
        ...valid,
        application_path: "main.js",
      }).success,
    ).toBe(false);
  });

  it("rejects a relative application root", () => {
    expect(
      electronActiveObservationInputSchema.safeParse({
        ...valid,
        application_root: "app",
      }).success,
    ).toBe(false);
  });

  it("accepts absolute observation paths", () => {
    expect(
      electronActiveObservationInputSchema.safeParse({
        ...valid,
        application_root: "/tmp/electron-app",
      }).success,
    ).toBe(true);
  });

  it("still accepts omitting the application root", () => {
    expect(electronActiveObservationInputSchema.safeParse(valid).success).toBe(
      true,
    );
  });
});

describe("expected server path requires an absolute local path", () => {
  it("rejects a relative server path", () => {
    expect(
      binarySessionInputSchema.safeParse({
        expected_server_path: "dist/main.js",
      }).success,
    ).toBe(false);
  });

  it("accepts an absolute server path", () => {
    expect(
      binarySessionInputSchema.safeParse({
        expected_server_path: "/opt/rea/dist/main.js",
      }).success,
    ).toBe(true);
  });

  it("still accepts omitting the server path", () => {
    expect(binarySessionInputSchema.safeParse({}).success).toBe(true);
  });
});

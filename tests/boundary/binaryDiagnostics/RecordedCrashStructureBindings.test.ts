import { expect, it } from "vitest";
import {
  recordedCrashFixture,
  recordedCrashFixtureBytes,
} from "../../fixtures/binaryDiagnostics/recordedCrash.js";
import { validateRecordedCrashStructure } from "../../../src/native/pwntools/RecordedCrashStructureBindings.js";

it.each([
  [6, 0],
  [6, 2],
  [20, 0],
  [20, 2],
] as const)(
  "rejects non-current ELF version at byte %i: %i",
  (offset, version) => {
    const report = recordedCrashFixture();
    const snapshot = recordedCrashFixtureBytes(report);
    if (offset === 6) snapshot[offset] = version;
    else snapshot.writeUInt32LE(version, offset);
    expect(() =>
      validateRecordedCrashStructure(
        report,
        snapshot,
        report.decoder_diagnostics,
      ),
    ).toThrow(/Reported core structure differs/);
  },
);

import { expect, it } from "vitest";
import {
  recordedCrashFixture,
  recordedCrashFixtureBytes,
} from "../../fixtures/binaryDiagnostics/recordedCrash.js";
import { validateRecordedCrashStructure } from "../../../src/native/pwntools/RecordedCrashStructureBindings.js";
import { RECORDED_LINUX_CORE_PROFILES } from "../../../src/domain/native/recordedCrash.js";

it.each(["x86_64-little-endian", "aarch64-little-endian"] as const)(
  "admits a %s core whose header carries that profile's e_machine",
  (architecture) => {
    const report = recordedCrashFixture(undefined, architecture);
    expect(() =>
      validateRecordedCrashStructure(
        report,
        recordedCrashFixtureBytes(report),
        report.decoder_diagnostics,
      ),
    ).not.toThrow();
  },
);

it.each([
  ["x86_64-little-endian", "aarch64-little-endian"],
  ["aarch64-little-endian", "x86_64-little-endian"],
] as const)(
  "rejects a %s report whose header carries the other profile's e_machine",
  (reported, embedded) => {
    const report = recordedCrashFixture(undefined, reported);
    const snapshot = recordedCrashFixtureBytes(report);
    snapshot.writeUInt16LE(RECORDED_LINUX_CORE_PROFILES[embedded].machine, 18);
    expect(() =>
      validateRecordedCrashStructure(
        report,
        snapshot,
        report.decoder_diagnostics,
      ),
    ).toThrow(/Reported core structure differs/);
  },
);

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

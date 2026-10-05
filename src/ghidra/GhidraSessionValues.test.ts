import { describe, expect, it } from "vitest";

import {
  GHIDRA_SESSION_CAPABILITIES,
  parseGhidraSessionInfo,
} from "./GhidraSessionValues.js";

const expected = {
  runId: "d6fcbb66-e829-4ff6-a535-0035aec63139",
  providerVersion: "12.1.4",
  profileDigest: "a".repeat(64),
  targetSha256: "b".repeat(64),
  expectedLanguageId: "x86:LE:16:Real Mode",
  expectedCompilerSpecId: "default",
};
const session = (
  language = expected.expectedLanguageId,
  compiler = "default",
) => ({
  name: "REA Ghidra bridge",
  run_id: expected.runId,
  profile_digest: expected.profileDigest,
  provider: { id: "ghidra", version: expected.providerVersion },
  read_only: true,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "legacy.exe",
    language_id: language,
    compiler_spec_id: compiler,
    image_base: "0x0",
    default_address_space: "ram",
    sha256: expected.targetSha256,
  },
});

describe("Ghidra DOS import commitment", () => {
  it("accepts the exact admitted real-mode language and compiler", () => {
    expect(parseGhidraSessionInfo(session(), expected).ok).toBe(true);
  });
  it("rejects a 32-bit interpretation even when artifact and profile hashes match", () => {
    expect(
      parseGhidraSessionInfo(session("x86:LE:32:default"), expected).ok,
    ).toBe(false);
  });
  it("rejects compiler drift independently of the language", () => {
    expect(
      parseGhidraSessionInfo(session(undefined, "windows"), expected).ok,
    ).toBe(false);
  });
});

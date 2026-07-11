import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorHost } from "../src/application/Doctor.js";

const host = (overrides: Partial<DoctorHost> = {}): DoctorHost => ({
  platform: "darwin",
  nodeVersion: "22.1.0",
  macosVersion: () => Promise.resolve("12.0"),
  readable: (path) => Promise.resolve(path.includes("Hopper")),
  brewHopperPath: () => Promise.resolve(undefined),
  manualHopperPaths: () => Promise.resolve([]),
  ...overrides,
});

describe("doctor", () => {
  it.each(["11.7", undefined])(
    "rejects unsupported macOS version %s",
    async (version) => {
      const result = await runDoctor(
        undefined,
        host({ macosVersion: () => Promise.resolve(version) }),
      );
      expect(result.checks.find(({ name }) => name === "macos")?.ok).toBe(
        false,
      );
    },
  );
  it("detects a manual configured Hopper before Homebrew", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredHopperPath: "/manual/Hopper",
        readable: (path) => Promise.resolve(path === "/manual/Hopper"),
      }),
    );
    expect(result.hopperPath).toBe("/manual/Hopper");
    expect(result.healthy).toBe(true);
  });
  it("detects a Homebrew cask installed outside /Applications", async () => {
    const path =
      "/opt/homebrew/Caskroom/hopper/Hopper Disassembler.app/Contents/MacOS/hopper";
    const result = await runDoctor(
      undefined,
      host({
        readable: (candidate) => Promise.resolve(candidate === path),
        brewHopperPath: () => Promise.resolve(path),
      }),
    );
    expect(result.hopperPath).toBe(path);
  });

  it("detects a manually installed Hopper application", async () => {
    const path = "/Applications/Hopper v6.app/Contents/MacOS/hopper";
    const result = await runDoctor(
      undefined,
      host({
        readable: (candidate) => Promise.resolve(candidate === path),
        manualHopperPaths: () => Promise.resolve([path]),
      }),
    );
    expect(result.hopperPath).toBe(path);
  });
});

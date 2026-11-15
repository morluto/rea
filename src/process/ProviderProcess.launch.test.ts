import { expect, it, vi } from "vitest";
import * as windows from "../windows/WindowsOwnedProcess.js";
import { spawnOwnedProviderProcess } from "./ProviderProcess.js";

// Select the composed host fact, not Node's mutable ambient process property.
vi.mock("../platform/HostPlatform.js", () => ({
  HOST_PLATFORM: Object.freeze({
    platform: "win32",
    architecture: process.arch,
  }),
}));

it.each([
  {
    constraint: "Create process atomically inside owned Job Object failed",
    states: ["attempting", "not_started"],
  },
  {
    constraint: "Suspended process has no owned Job Object membership",
    states: ["attempting"],
  },
  { constraint: undefined, states: ["attempting"] },
])(
  "preserves native launch proof for $constraint",
  async ({ constraint, states }) => {
    const failure = Object.assign(new Error("Native launch failed"), {
      constraint,
    });
    const constructor = vi
      .spyOn(windows, "WindowsOwnedProcess")
      .mockImplementation(
        class {
          constructor() {
            throw failure;
          }
        } as unknown as typeof windows.WindowsOwnedProcess,
      );
    const observed: string[] = [];
    try {
      await expect(
        spawnOwnedProviderProcess({
          command: "C:\\adb.exe",
          arguments: [],
          runId: "launch-proof",
          hostEnvironment: {},
          onLaunchState: (state) => observed.push(state),
        }),
      ).rejects.toBe(failure);
      expect(observed).toEqual(states);
    } finally {
      constructor.mockRestore();
    }
  },
);

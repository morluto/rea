import { expect, it, vi } from "vitest";
import * as windows from "../windows/WindowsOwnedProcess.js";
import { spawnOwnedProviderProcess } from "./ProviderProcess.js";

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
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const observed: string[] = [];
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
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
      Object.defineProperty(process, "platform", platform);
      constructor.mockRestore();
    }
  },
);

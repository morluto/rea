import * as fsPromises from "node:fs/promises";
import { onTestFinished, vi } from "vitest";

export const realRm = (
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
).rm;

export const interceptFlutterRootRemoval = (
  remove: (root: string) => Promise<void>,
): void => {
  const spy = vi
    .spyOn(fsPromises, "rm")
    .mockImplementation((path, options) =>
      typeof path === "string" &&
      path.split(/[\\/]/u).at(-1)?.startsWith("rea-flutter-")
        ? remove(path)
        : realRm(path, options),
    );
  onTestFinished(() => spy.mockRestore());
};

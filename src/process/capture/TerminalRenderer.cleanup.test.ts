import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { TerminalRenderer } from "./TerminalRenderer.js";

const require = createRequire(import.meta.url);
const { Terminal } =
  require("@xterm/headless") as typeof import("@xterm/headless");
it("releases the actual headless terminal after a queued observation fails", async () => {
  const dispose = vi.spyOn(Terminal.prototype, "dispose");
  const failure = new Error("observation failed");
  const renderer = new TerminalRenderer({
    columns: 20,
    rows: 4,
    scrollback: 10,
    maxBytes: 100_000,
    normalize: () => {
      throw failure;
    },
  });
  renderer.resize(21, 4, 0);
  await expect(renderer.frames()).rejects.toBe(failure);
  try {
    await expect(renderer.dispose()).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    dispose.mockRestore();
  }
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

const observation = vi.hoisted(() => ({
  serial: 0,
  failure: Object.assign(new Error("inert workspace observation"), {
    code: "ENOENT",
  }),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (!String(args[0]).startsWith("/rea-inert/")) return fs.stat(...args);
      if (String(args[0]).endsWith("synthetic.txt")) return {};
      throw observation.failure;
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => {
      if (args[1]?.[1] !== "owner") return cp.spawn(...args);
      const events = new EventEmitter();
      const child = Object.assign(events, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null,
        kill() {
          this.exitCode = 0;
          events.emit("close", 0);
          return true;
        },
      });
      const path = `/rea-inert/owned-${++observation.serial}`;
      queueMicrotask(() => child.stdout.write(JSON.stringify({ path }) + "\n"));
      return child;
    },
  };
});
const { verifyWindowsGuardianIsolation } = await vi.importActual<{
  verifyWindowsGuardianIsolation(): Promise<void>;
}>("../../../scripts/verify/android/windows-guardian-isolation.mjs");

it.each(["ENOENT", "ENOTDIR", "EACCES", "EIO"])(
  "admits only known workspace absence after owner exit (%s)",
  async (code) => {
    observation.failure = Object.assign(new Error(`inert stat ${code}`), {
      code,
    });
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    if (original === undefined) throw new Error("Platform descriptor missing");
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      const result = verifyWindowsGuardianIsolation();
      if (code === "ENOENT" || code === "ENOTDIR")
        await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toBe(observation.failure);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  },
);

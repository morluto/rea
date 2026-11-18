import { expect, it, vi } from "vitest";
import { runUninstall, type UninstallHost } from "./Uninstall.js";

it.each(["failed", "removed", "retained", "skipped"] as const)(
  "honors managed-skill removal status before purging data: %s",
  async (status) => {
    const purgeData = vi.fn<UninstallHost["purgeData"]>(async () => [
      { name: "cache", status: "removed", detail: "Removed fixture cache." },
    ]);
    const close = vi.fn<NonNullable<UninstallHost["close"]>>(
      async () => undefined,
    );
    const host: UninstallHost = {
      clients: async () => [],
      inspectClient: async () => undefined,
      removeClient: async () => ({
        name: "client",
        status: "skipped",
        detail: "Absent.",
      }),
      removeSkill: async () => ({
        name: "skill",
        status,
        detail: "Fixture skill outcome.",
      }),
      purgeData,
      close,
    };

    const result = await runUninstall(true, host);

    expect(close).toHaveBeenCalledOnce();
    expect(result.status).toBe(status === "failed" ? "failed" : "complete");
    expect(result.items).toContainEqual({
      name: "skill",
      status,
      detail: "Fixture skill outcome.",
    });
    if (status === "failed") {
      expect(purgeData).not.toHaveBeenCalled();
      expect(result.items).toContainEqual(
        expect.objectContaining({ name: "uninstall", status: "skipped" }),
      );
      expect(result.items.some(({ name }) => name === "cache")).toBe(false);
    } else {
      expect(purgeData).toHaveBeenCalledOnce();
      expect(result.items).toContainEqual({
        name: "cache",
        status: "removed",
        detail: "Removed fixture cache.",
      });
    }
  },
);

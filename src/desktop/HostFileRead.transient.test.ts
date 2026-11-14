import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]).endsWith("transient.so"))
        throw Object.assign(new Error("injected I/O failure"), {
          code: "EIO",
        });
      return fs.stat(...args);
    },
  };
});

import { hostFileKind, probeHostFile } from "./HostFileRead.js";

it("keeps a transient stat failure unresolved rather than absent", async () => {
  // EIO neither proves absence nor lets ld.so search past the candidate.
  await expect(probeHostFile("/fixture/lib/transient.so")).resolves.toEqual({
    kind: "unknown",
    unreachable: false,
  });
  await expect(hostFileKind("/fixture/lib/transient.so")).resolves.toBeNull();
});

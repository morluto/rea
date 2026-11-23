import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect } from "vitest";

import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { awaitAcknowledgement } from "../fixtures/lifecycleAcknowledgement.js";
import { workspaceCliTest } from "../support/cli/workspaceCliFixture.js";

// Only the encoder's document size and one admitted I/O completion are
// controlled. The real dispatcher owns signals, stdout and staged resources.
const stagingHook = (phase: "stage" | "delivery" | "cleanup") =>
  `data:text/javascript,${encodeURIComponent(`
import fs from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
let held = false;
const gate = async () => {
  if (held) return;
  held = true;
  const released = new Promise(resolve => process.stdin.once("data", resolve));
  process.stderr.write("REA_TOON_PHASE:${phase}\\n");
  await released;
  process.stdin.pause();
};
const originalOpen = fs.open;
fs.open = async (...args) => {
  const file = await originalOpen(...args);
  if (String(args[0]).endsWith("/output")) {
    const method = ${JSON.stringify(phase === "cleanup" ? "close" : "writeFile")};
    const original = file[method].bind(file);
    file[method] = async (...args) => {
      if (${JSON.stringify(phase)} !== "delivery") await gate();
      return original(...args);
    };
  }
  return file;
};
syncBuiltinESMExports();
if (${JSON.stringify(phase)} === "delivery") {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (...args) {
    if (!held) {
      void gate().then(() => originalWrite(...args));
      return false;
    }
    return originalWrite(...args);
  };
}
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith("/@toon-format/toon/dist/index.mjs")) return loaded;
    const signature = "function encodeLines(input, options) {";
    const source = String(loaded.source);
    if (!source.includes(signature)) throw new Error("Pinned TOON boundary changed");
    return { ...loaded, source: source.replace(signature, signature +
      ' if (input?.operation === "inspect_managed_artifact") return Array.from({length: 24}, () => "x".repeat(65536)).values();') };
  }
});
`)}`;

workspaceCliTest.skipIf(!["linux", "darwin"].includes(process.platform)).for(
  (["stage", "delivery", "cleanup"] as const).flatMap((phase) =>
    (
      [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const
    ).map(([signal, status]) => ({ phase, signal, status })),
  ),
)(
  "TOON $phase retains its stage through $signal and exits $status",
  async ({ phase, signal, status }, { processes, workspace }) => {
    const target = join(workspace.root, "fixture.dll");
    const temporary = join(workspace.root, "temporary");
    await writeFile(target, buildManagedPeFixture());
    await mkdir(temporary);
    let acknowledgePhase!: () => void;
    const phaseAcknowledged = new Promise<void>((resolve) => {
      acknowledgePhase = resolve;
    });
    const child = processes.spawn(
      process.execPath,
      [
        "--import",
        stagingHook(phase),
        resolve("scripts/rea.mjs"),
        "inspect-managed-artifact",
        target,
      ],
      {
        cwd: workspace.root,
        env: { TMPDIR: temporary, PATH: process.env.PATH },
      },
    );
    let stderr = "";
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes(`REA_TOON_PHASE:${phase}\n`)) acknowledgePhase();
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      await awaitAcknowledgement(
        phaseAcknowledged,
        closed,
        `TOON ${phase} phase`,
      );
      expect(await readdir(temporary)).toHaveLength(1);
      expect(child.kill(signal)).toBe(true);
      child.stdin.end("release");
      const result = await closed;
      expect(await readdir(temporary), JSON.stringify(result)).toEqual([]);
      expect(result, stderr).toEqual({ code: status, signal: null });
      expect(stderr.trim()).toBe(`REA_TOON_PHASE:${phase}`);
      if (phase === "stage") expect(bytes).toBe(0);
      if (phase === "delivery") {
        expect(bytes).toBeGreaterThan(0);
        expect(bytes).toBeLessThan(24 * (65536 + 1));
      }
      // Cleanup starts only after the full controlled document was delivered.
      if (phase === "cleanup") expect(bytes).toBe(24 * (65536 + 1));
    } finally {
      if (!child.stdin.destroyed) child.stdin.end("release");
      await processes.shutdown();
      await closed;
    }
  },
);

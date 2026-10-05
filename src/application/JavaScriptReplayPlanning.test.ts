import { describe, expect, it, vi } from "vitest";

import {
  prepareReplayPlan,
  type JavaScriptReplayConfiguration,
  type JavaScriptReplayHost,
} from "./JavaScriptReplayPlanning.js";
import { controlledReplayInputSchema } from "../domain/javascriptReplay.js";

const root = "/replay-fixture";
const configuration: JavaScriptReplayConfiguration = {
  nodePath: "/runtime/node",
  bubblewrapPath: "/runtime/bwrap",
  systemdRunPath: "/runtime/systemd-run",
  systemctlPath: "/runtime/systemctl",
  shellPath: "/runtime/sh",
};

const inputWithExpandedManifest = () => {
  const modules = Array.from({ length: 130 }, (_, index) => ({
    alias: `module-${index}`,
    path: `${root}/module.mjs`,
    format: "esm" as const,
    role: "module" as const,
    dependencies: {},
  }));
  const first = modules[0];
  if (first === undefined) throw new TypeError("Missing fixture module");
  modules[0] = {
    ...first,
    dependencies: Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        `dependency-${index}`,
        `module-${index + 1}`,
      ]),
    ),
  };
  return controlledReplayInputSchema.parse({
    mode: "plan",
    left: {
      modules,
      entry_alias: "module-0",
      entry_export: "default",
    },
    cases: Array.from({ length: 129 }, (_, index) => ({
      case_id: `case-${index}`,
      arguments: Array.from({ length: 17 }, () => "value"),
    })),
  });
};

describe("controlled replay planning input bounds", () => {
  it("accepts module, dependency, case, and argument counts beyond old quotas", () => {
    const input = inputWithExpandedManifest();

    expect(input.left.modules).toHaveLength(130);
    expect(Object.keys(input.left.modules[0]?.dependencies ?? {})).toHaveLength(
      129,
    );
    expect(input.cases).toHaveLength(129);
    expect(input.cases[0]?.arguments).toHaveLength(17);
  });

  it("rejects an oversized protocol manifest before probing or reading", async () => {
    const probe = vi.fn(async () => undefined);
    const readSource = vi.fn(async () => ({
      canonicalPath: `${root}/module.mjs`,
      bytes: new Uint8Array(),
    }));
    const host: JavaScriptReplayHost = {
      readSource,
      identifyExecutable: vi.fn(async (path) => ({
        path,
        version: "1",
        sha256: "0".repeat(64),
      })),
      identifyWorker: vi.fn(async () => ({
        path: "/worker.js",
        version: "1",
        sha256: "0".repeat(64),
      })),
      identifyRuntimeClosure: vi.fn(async () => []),
      seccompDigest: () => "0".repeat(64),
      probe,
    };
    const input = controlledReplayInputSchema.parse({
      mode: "plan",
      left: {
        modules: Array.from({ length: 300 }, (_, index) => ({
          alias: `module-${index}`,
          path: `/${"p".repeat(4_095)}`,
          format: "esm",
          dependencies: {},
        })),
        entry_alias: "module-0",
      },
      cases: [{ case_id: "empty", arguments: [] }],
      limits: { protocol_bytes: 1024 * 1024 },
    });

    await expect(prepareReplayPlan(input, configuration, host)).rejects.toThrow(
      "Replay plan input exceeds its protocol byte limit",
    );
    expect(probe).not.toHaveBeenCalled();
    expect(readSource).not.toHaveBeenCalled();
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  XpandaProvider,
  type XpandaPublicationHooks,
} from "../../../../src/harmony/XpandaProvider.js";
import type { OwnedMcpLauncher } from "../../../../src/process/OwnedMcpStdioTransport.js";
import { spawnOwnedProviderProcess } from "../../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  writeFakeXpandaServer,
  type FakeXpandaBehavior,
} from "./fakeXpandaMcp.js";

export interface XpandaFixture {
  readonly root: string;
  readonly fakeServer: string;
  readonly behaviorPath: string;
  readonly callsPath: string;
  readonly targetPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly provider: XpandaProvider;
}

/** Create a fake xpanda checkout, an .abc target and a provider wired to both. */
export const xpandaFixture = async (
  behavior: FakeXpandaBehavior = {},
  options: {
    readonly version?: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly idleRetireMs?: number;
    readonly publication?: XpandaPublicationHooks;
  } = {},
): Promise<XpandaFixture> => {
  const root = await createTestTempDirectory("rea-xpanda-checkout-");
  await mkdir(join(root, "src", "mcp"), { recursive: true });
  await mkdir(join(root, "node_modules", "tsx"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "xpanda",
      version: options.version ?? "2.1.0",
    }),
  );
  // The production launch command runs `node --import tsx src/mcp/server.ts`
  // with cwd at the checkout; the injected launcher swaps that invocation for
  // the fake engine script executed directly.
  await writeFile(join(root, "src", "mcp", "server.ts"), "// producer entry\n");
  await writeFile(
    join(root, "node_modules", "tsx", "package.json"),
    JSON.stringify({ name: "tsx", version: "4.7.0" }),
  );
  const fakeServer = await writeFakeXpandaServer(join(root, "src", "mcp"));
  const behaviorPath = join(root, "behavior.json");
  await writeFile(behaviorPath, JSON.stringify(behavior));
  const callsPath = join(root, "calls.jsonl");
  const targetPath = join(root, "module.abc");
  // PANDA magic prefix keeps the target structurally honest; the fake engine
  // never parses bytes, but admission hashing does.
  await writeFile(targetPath, "PANDA\0\0\0fake-ark-bytecode");
  const environment: Record<string, string> = {
    REA_XPANDA_ROOT: root,
    REA_TEST_XPANDA_BEHAVIOR: behaviorPath,
    REA_TEST_XPANDA_CALLS: callsPath,
    ...options.environment,
  };
  const launcher: OwnedMcpLauncher = async (spawnOptions) =>
    spawnOwnedProviderProcess({
      ...spawnOptions,
      arguments: [fakeServer],
    });
  return {
    root,
    fakeServer,
    behaviorPath,
    callsPath,
    targetPath,
    environment,
    provider: new XpandaProvider(environment, launcher, {
      ...(options.idleRetireMs === undefined
        ? {}
        : { idleRetireMs: options.idleRetireMs }),
      ...(options.publication === undefined
        ? {}
        : { publication: options.publication }),
    }),
  };
};

/** Replace the scripted behavior of an existing fake checkout. */
export const setFakeXpandaBehavior = (
  behaviorPath: string,
  behavior: FakeXpandaBehavior,
): Promise<void> => writeFile(behaviorPath, JSON.stringify(behavior));

/** Requests the fake engine recorded, oldest first. */
export const fakeXpandaCalls = async (
  callsPath: string,
): Promise<readonly Record<string, unknown>[]> => {
  const text = await readFile(callsPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

export const tempRoot = (): Promise<string> =>
  createTestTempDirectory("rea-xpanda-run-");

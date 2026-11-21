import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { expect, it } from "vitest";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import {
  classifyClientRegistrationCommand,
  currentClientRegistrationCommand,
} from "../../../src/application/ClientRegistrationIdentity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// The bin shim aube (mise's npm backend) wrote for rea-agents 6.7.0.
const aubeShim = (target: string): string => `#!/bin/sh
# aube-bin-shim v2 target=${target}
link="$0"
hops=0
while [ -L "$link" ] && [ "$hops" -lt 40 ]; do
  hops=$((hops+1))
  target=$(readlink "$link")
  case "$target" in
    /*) link="$target" ;;
    *)  link="$(dirname "$link")/$target" ;;
  esac
done
basedir=$(dirname "$link")
export NODE_PATH="$basedir/..:$basedir/../.mise/node_modules"
if [ -x "$basedir/node" ]; then
 exec "$basedir/node" "$basedir/${target}" "$@"
else
 exec node "$basedir/${target}" "$@"
fi
`;

const storeTarget = (version: string): string =>
  `../.mise/rea-agents@${version}/node_modules/rea-agents/scripts/rea.mjs`;

/**
 * Lay out a mise install the way mise does: each version in its own directory
 * under `installs/rea`, and `latest` a symlink to the newest. Returns the
 * entrypoint and shim as REA sees them when launched through `latest`.
 */
const installWithMise = async (
  installs: string,
  version: string,
  shimTarget = storeTarget(version),
): Promise<{ entrypoint: string; shim: string }> => {
  const bin = join(installs, version, "node_modules", ".bin");
  const script = join(bin, storeTarget(version));
  await mkdir(dirname(script), { recursive: true });
  await writeFile(
    script,
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
  );
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(join(bin, "rea"), aubeShim(shimTarget), { mode: 0o755 });
  await rm(join(installs, "latest"), { force: true });
  await symlink(`./${version}`, join(installs, "latest"));
  const latestBin = join(installs, "latest", "node_modules", ".bin");
  return {
    entrypoint: join(latestBin, storeTarget(version)),
    shim: join(latestBin, "rea"),
  };
};

const bindAubeShimNode = async (
  shim: string,
  version: string,
  runtime: string,
): Promise<void> => {
  const target = storeTarget(version);
  const header = Buffer.from(
    JSON.stringify({ target, node: runtime, args: [] }),
  ).toString("hex");
  const template = aubeShim(target).split("if [ -x")[0]!;
  const content = template.replace(
    `# aube-bin-shim v2 target=${target}\n`,
    `# aube-bin-shim v2 target=${target}\n# aube-node-shim v1 ${header}\n`,
  );
  await writeFile(
    shim,
    content + `exec '${runtime}' "$basedir/"'${target}' "$@"\n`,
  );
};

const registerCommand = (
  entrypointPath: string,
  environment: NodeJS.ProcessEnv = {},
): readonly string[] =>
  currentClientRegistrationCommand({
    platform: "linux",
    entrypointPath,
    environment,
  });

const launchFromClient = (command: readonly string[]) =>
  execFileSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    env: { PATH: "" },
  }).trim();

const registerWithClaudeCode = async (
  home: string,
  command: readonly string[],
): Promise<void> => {
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        rea: { command: command[0], args: command.slice(1) },
      },
    }),
  );
};

const claudeCodeState = async (
  home: string,
  entrypoint: string,
): Promise<string | undefined> =>
  (
    await readClientRegistrationStatuses(home, entrypoint, {
      platform: "linux",
      environment: {},
    })
  ).find(({ client }) => client === "claude_code")?.state;

it.skipIf(process.platform === "win32")(
  "registers the aube bin shim, which stays aligned across a mise upgrade",
  async () => {
    const home = await createTestTempDirectory("rea-aube-registration-");
    const installs = join(home, "installs", "rea");
    const before = await installWithMise(installs, "6.7.0");

    const command = registerCommand(before.entrypoint);
    expect(command.slice(-3)).toEqual([before.shim, process.execPath, "mcp"]);
    expect(classifyClientRegistrationCommand(command, before.entrypoint)).toBe(
      "owned",
    );
    await registerWithClaudeCode(home, command);
    expect(await claudeCodeState(home, before.entrypoint)).toBe("aligned");
    expect(launchFromClient(command)).toBe("6.7.0");

    // mise installs the new version beside the old, repoints `latest`, and
    // prunes the old directory.
    const after = await installWithMise(installs, "6.8.0");
    await rm(join(installs, "6.7.0"), { recursive: true });
    expect(after.shim).toBe(before.shim);
    expect(registerCommand(after.entrypoint)).toEqual(command);
    expect(await claudeCodeState(home, after.entrypoint)).toBe("aligned");
    expect(launchFromClient(command)).toBe("6.8.0");
  },
);

it.skipIf(process.platform === "win32")(
  "reports a registered aube store script as stale so setup moves it to the shim",
  async () => {
    const home = await createTestTempDirectory("rea-aube-legacy-");
    const { entrypoint } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );

    const oldCommand = [process.execPath, entrypoint, "mcp"];
    await registerWithClaudeCode(home, oldCommand);
    expect(classifyClientRegistrationCommand(oldCommand, entrypoint)).toBe(
      "owned",
    );
    expect(await claudeCodeState(home, entrypoint)).toBe("stale");
  },
);

it.skipIf(process.platform === "win32")(
  "owns a link to the shim, which runs the target beside the real shim",
  async () => {
    const home = await createTestTempDirectory("rea-aube-link-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const link = join(home, "bin", "rea");
    await mkdir(dirname(link), { recursive: true });
    await symlink(shim, link);

    expect(classifyClientRegistrationCommand([link, "mcp"], entrypoint)).toBe(
      "owned",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the script path when the shim does not run this entrypoint",
  async () => {
    const home = await createTestTempDirectory("rea-aube-foreign-shim-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
      "../.mise/other@1.0.0/node_modules/other/bin.js",
    );

    const foreign = join(
      dirname(shim),
      "../.mise/other@1.0.0/node_modules/other/bin.js",
    );
    await mkdir(dirname(foreign), { recursive: true });
    await writeFile(foreign, "console.log('different package');\n");

    expect(registerCommand(entrypoint)).toEqual([
      process.execPath,
      entrypoint,
      "mcp",
    ]);
    expect(classifyClientRegistrationCommand([shim, "mcp"], entrypoint)).toBe(
      "foreign",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "ignores shims in a format it does not know",
  async () => {
    const home = await createTestTempDirectory("rea-aube-unknown-shim-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    await writeFile(
      shim,
      aubeShim(storeTarget("6.7.0")).replace(
        "aube-bin-shim v2",
        "aube-bin-shim v3",
      ),
    );

    expect(registerCommand(entrypoint)).toEqual([
      process.execPath,
      entrypoint,
      "mcp",
    ]);
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "marker-only",
    "different-local-node",
    "different-bound-node",
  ] as const)(
  "keeps the explicit runtime for a %s Aube launcher",
  async (cause) => {
    const home = await createTestTempDirectory("rea-aube-unverified-shim-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    if (cause === "marker-only")
      await writeFile(
        shim,
        `#!/bin/sh\n# aube-bin-shim v2 target=${storeTarget("6.7.0")}\nexit 44\n`,
      );
    else {
      const interpreter = join(dirname(shim), "node");
      await rm(interpreter);
      await writeFile(interpreter, "#!/bin/sh\nexit 44\n", { mode: 0o755 });
      if (cause === "different-bound-node")
        await bindAubeShimNode(shim, "6.7.0", interpreter);
    }
    expect(registerCommand(entrypoint)).toEqual([
      process.execPath,
      entrypoint,
      "mcp",
    ]);
    expect(classifyClientRegistrationCommand([shim, "mcp"], entrypoint)).toBe(
      "foreign",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "executes an Aube host-bound interpreter with no Node on the client PATH",
  async () => {
    const home = await createTestTempDirectory("rea-aube-host-bound-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const legacy = registerCommand(entrypoint);
    await rm(join(dirname(shim), "node"));
    await bindAubeShimNode(shim, "6.7.0", process.execPath);
    expect(launchFromClient(legacy)).toBe("6.7.0");
    await registerWithClaudeCode(home, legacy);
    expect(await claudeCodeState(home, entrypoint)).toBe("stale");
    const command = registerCommand(entrypoint);
    expect(command.slice(-3)).toEqual([shim, process.execPath, "mcp"]);
    expect(launchFromClient(command)).toBe("6.7.0");
  },
);

it.skipIf(process.platform === "win32")(
  "keeps an alias with a different Node-resolved script outside the owned registration",
  async () => {
    const home = await createTestTempDirectory("rea-aube-parent-alias-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const aliasParent = join(home, "alias");
    await mkdir(aliasParent);
    await symlink(dirname(shim), join(aliasParent, ".bin"), "dir");
    const alias = join(aliasParent, ".bin", "rea");
    expect(classifyClientRegistrationCommand([alias, "mcp"], entrypoint)).toBe(
      "unknown",
    );
    const installed = registerCommand(entrypoint);
    expect(launchFromClient(installed)).toBe("6.7.0");
  },
);

it.skipIf(process.platform === "win32")(
  "classifies a registered FIFO without blocking on it",
  async () => {
    const home = await createTestTempDirectory("rea-aube-fifo-");
    const { entrypoint } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const fifo = join(home, "rea-fifo");
    execFileSync("mkfifo", [fifo]);

    expect(classifyClientRegistrationCommand([fifo, "mcp"], entrypoint)).toBe(
      "foreign",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "binds the selected Node for a generated shim without a sibling interpreter",
  async () => {
    const home = await createTestTempDirectory("rea-aube-external-node-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    await rm(join(dirname(shim), "node"));
    await writeFile(
      entrypoint,
      "console.log(JSON.stringify({path: process.env.PATH, args: process.argv.slice(2)}));\n",
    );
    const command = registerCommand(entrypoint);
    expect(command.slice(3)).toEqual([shim, process.execPath, "mcp"]);
    expect(classifyClientRegistrationCommand(command, entrypoint)).toBe(
      "owned",
    );
    expect(JSON.parse(launchFromClient(command))).toEqual({
      path: "",
      args: ["mcp"],
    });
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "a symlink through a session directory",
    "the first Node on setup's PATH",
  ] as const)(
  "launches the saved Aube registration after removal of a sibling Node that was %s",
  async (sibling) => {
    const home = await createTestTempDirectory("rea-aube-sibling-node-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const bin = dirname(shim);
    const interpreter = join(bin, "node");
    const session = join(home, "fnm_multishells", "123_456");
    const throughSession = sibling === "a symlink through a session directory";
    if (throughSession) {
      await mkdir(session, { recursive: true });
      const sessionRuntime = join(session, "node");
      await symlink(process.execPath, sessionRuntime);
      await rm(interpreter);
      await symlink(sessionRuntime, interpreter);
    }

    const command = registerCommand(entrypoint, { PATH: bin });
    await registerWithClaudeCode(home, command);
    expect(launchFromClient(command)).toBe("6.7.0");

    await rm(throughSession ? session : interpreter, {
      recursive: throughSession,
    });
    expect(launchFromClient(command)).toBe("6.7.0");
    expect(await claudeCodeState(home, entrypoint)).toBe("aligned");
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["unbound", "host-bound"] as const)(
  "keeps an independent Node alias after runtime removal with %s Aube binding",
  async (binding) => {
    const home = await createTestTempDirectory("rea-aube-node-upgrade-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const oldVersion = join(home, "node-versions", "old");
    const oldRuntime = join(oldVersion, "node");
    await mkdir(oldVersion, { recursive: true });
    await copyFile(process.execPath, oldRuntime, constants.COPYFILE_FICLONE);

    const bin = dirname(shim);
    const sibling = join(bin, "node");
    const dependentBin = join(home, "dependent-bin");
    const stableBin = join(home, "stable-bin");
    const fallback = join(stableBin, "node");
    await mkdir(dependentBin);
    await mkdir(stableBin);
    await rm(sibling);
    await symlink(oldRuntime, sibling);
    await symlink(sibling, join(dependentBin, "node"));
    await symlink(oldRuntime, fallback);
    if (binding === "host-bound")
      await bindAubeShimNode(shim, "6.7.0", oldRuntime);
    await writeFile(entrypoint, "console.log(process.execPath);\n");

    const owner = new URL(
      "../../../dist/application/ClientRegistrationIdentity.js",
      import.meta.url,
    );
    const command: readonly string[] = JSON.parse(
      execFileSync(
        oldRuntime,
        [
          "--input-type=module",
          "--eval",
          `
          import { currentClientRegistrationCommand } from ${JSON.stringify(owner.href)};
          console.log(JSON.stringify(currentClientRegistrationCommand({ entrypointPath: process.argv[1] })));
        `,
          entrypoint,
        ],
        {
          encoding: "utf8",
          env: { PATH: [dependentBin, bin, stableBin].join(delimiter) },
        },
      ),
    );
    expect(launchFromClient(command)).toBe(oldRuntime);
    await rm(sibling);
    expect(launchFromClient(command)).toBe(oldRuntime);

    await rm(fallback);
    await symlink(process.execPath, fallback);
    await rm(oldVersion, { recursive: true });
    expect(launchFromClient(command)).toBe(process.execPath);
    expect(registerCommand(entrypoint, { PATH: stableBin })).toEqual(command);
    await registerWithClaudeCode(home, command);
    expect(await claudeCodeState(home, entrypoint)).toBe("aligned");

    // A previously saved alias through the sibling still identifies REA,
    // but doctor should recommend a refresh before that sibling is removed.
    await symlink(process.execPath, sibling);
    const dependentCommand = command.map((word) =>
      word === fallback ? join(dependentBin, "node") : word,
    );
    await registerWithClaudeCode(home, dependentCommand);
    expect(
      classifyClientRegistrationCommand(dependentCommand, entrypoint),
    ).toBe("owned");
    expect(await claudeCodeState(home, entrypoint)).toBe("stale");
  },
);

it.skipIf(process.platform === "win32")(
  "checks the Node executable reached by the shell through symlink and parent traversal",
  async () => {
    const home = await createTestTempDirectory("rea-aube-native-node-path-");
    const { entrypoint, shim } = await installWithMise(
      join(home, "installs", "rea"),
      "6.7.0",
    );
    const lexicalBin = dirname(shim);
    const nativeBase = join(home, "native");
    const nativeBin = join(nativeBase, ".bin");
    await mkdir(join(nativeBase, "sub"), { recursive: true });
    await mkdir(nativeBin);
    await writeFile(join(nativeBin, "rea"), aubeShim(storeTarget("6.7.0")), {
      mode: 0o755,
    });
    await symlink(join(nativeBase, "sub"), join(lexicalBin, "..", "helper"));
    await rm(shim);
    await symlink("../helper/../.bin/rea", shim);
    const direct = [shim, "mcp"];
    // The Node script argument resolves lexically to the installed script.
    // The shell's earlier -x test resolves its own Node path natively.
    expect(classifyClientRegistrationCommand(direct, entrypoint)).not.toBe(
      "owned",
    );
    await rm(join(lexicalBin, "node"));
    await symlink(process.execPath, join(nativeBin, "node"));
    expect(classifyClientRegistrationCommand(direct, entrypoint)).toBe("owned");
    expect(launchFromClient(registerCommand(entrypoint))).toBe("6.7.0");
  },
);

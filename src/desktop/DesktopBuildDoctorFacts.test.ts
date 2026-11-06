import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { systemDoctorHost } from "../application/Doctor.js";
import { readDesktopBuildFacts } from "./DesktopBuildDoctorFacts.js";

const execute = promisify(execFile);

const program = (path: string, body: string) =>
  writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

const buildHost = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  await program(join(bin, "ps"), "exit 0");
  return { root, bin, home };
};

const readFacts = async (
  environment: NodeJS.ProcessEnv,
  clientIds: readonly string[],
) => {
  const host = systemDoctorHost({
    environment,
    platform: "linux",
    architecture: "x64",
    desktopBuildFacts: readDesktopBuildFacts,
  });
  try {
    return await host.desktopBuildFacts!(clientIds);
  } finally {
    await host.close?.();
  }
};

it.skipIf(process.platform === "win32")(
  "reads a refused daemon and names unrecorded settings without their values",
  async () => {
    const { root, bin, home } = await buildHost("rea-desktop-doctor-facts-");
    await program(
      join(bin, "docker"),
      'echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2\nexit 1',
    );
    await program(join(bin, "agent-env"), 'echo "agent-env 0.9.1400"');
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: process.execPath,
            args: ["/opt/rea/scripts/rea.mjs", "mcp"],
            env: { REA_AGENT_ENV_COMMAND: "/private/value/agent-env" },
          },
        },
      }),
    );

    const facts = await readFacts(
      {
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CACHE_HOME: join(root, "cache"),
      },
      ["claude_code"],
    );

    expect(facts).toMatchObject({
      ps: { found: true },
      docker: { status: "found", path: join(bin, "docker"), source: "path" },
      daemon: { status: "permission_denied" },
      agentEnv: { status: "found", version: "0.9.1400" },
      archive: { source: "cache", status: "missing" },
      registrations: [
        {
          client: "claude_code",
          registered: true,
          unrecorded: ["REA_BUILD_COMPUTER_REA_ARCHIVE", "REA_DOCKER_COMMAND"],
          unresolved: [],
        },
      ],
      leftoverContainers: undefined,
    });
    expect(JSON.stringify(facts)).not.toContain("/private/value");
  },
);

it.skipIf(process.platform === "win32")(
  "reads a selected archive's REA version and the sandboxes Docker still holds",
  async () => {
    const { root, bin, home } = await buildHost("rea-desktop-doctor-archive-");
    await program(
      join(bin, "docker"),
      [
        'if [ "$1" = info ]; then echo /srv/docker; exit 0; fi',
        'case "$4" in name=*) echo agent-0f3a;; label=*) printf "agent-0f3a\\nrelay-0f3a\\n";; esac',
      ].join("\n"),
    );
    const packed = join(root, "packed");
    await mkdir(join(packed, "rea-prod"), { recursive: true });
    await writeFile(
      join(packed, "rea-prod/package.json"),
      JSON.stringify({ name: "rea-agents", version: "6.7.0" }),
    );
    const archive = join(root, "rea-prod.tar.xz");
    await execute("tar", ["-cJf", archive, "-C", packed, "rea-prod"]);

    const facts = await readFacts(
      {
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}:/usr/bin:/bin`,
        REA_AGENT_ENV_COMMAND: "agent-env",
        REA_BUILD_COMPUTER_REA_ARCHIVE: archive,
      },
      [],
    );

    expect(facts).toMatchObject({
      daemon: { status: "reachable", rootDirectory: "/srv/docker" },
      agentEnv: { status: "invalid", value: "agent-env" },
      archive: { path: archive, source: "environment", status: "stale" },
      environmentSettings: [
        "REA_AGENT_ENV_COMMAND",
        "REA_BUILD_COMPUTER_REA_ARCHIVE",
      ],
      leftoverContainers: ["agent-0f3a", "relay-0f3a"],
    });
    expect(facts.archive.detail).toContain("6.7.0");
  },
);

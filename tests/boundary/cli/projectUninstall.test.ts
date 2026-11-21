import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

const put = async (
  path: string,
  document: Record<string, unknown> | string,
) => {
  await mkdir(dirname(path), { recursive: true });
  const text =
    typeof document === "string" ? document : JSON.stringify(document);
  await writeFile(path, text);
  return text;
};

const piRegistration = {
  command: "npx",
  args: ["-y", "rea-agents", "mcp"],
  enabled: false,
};
const openCodeRegistration = {
  type: "local",
  command: ["npx", "-y", "rea-agents", "mcp"],
};
const openCodePeer = { type: "local", command: ["unrelated", "mcp"] };

cliTest(
  "uninstall selects an explicit project, including disabled owned rows, while leaving ancestor and user files intact",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-project-uninstall-");
    const home = join(root, "home");
    const parent = join(root, "workspace");
    const project = join(parent, "selected");
    const piPath = join(project, ".pi", "mcp.json");
    const openCodePath = join(project, "opencode.jsonc");
    const environment = await registrationEnvironment(home);
    const piUser = join(home, ".pi", "agent", "mcp.json");
    const userOriginal = await put(piUser, {
      mcpServers: { peer: { command: "unrelated" } },
    });
    await put(join(home, ".pi", "agent", "trust.json"), { [project]: true });
    const ancestor = join(parent, "opencode.json");
    const ancestorOriginal = await put(ancestor, {
      mcp: { servers: { ancestor: openCodePeer } },
    });
    const piOriginal = await put(piPath, {
      mcpServers: { rea: piRegistration, peer: { command: "unrelated" } },
    });
    const openCodeOriginal = await put(openCodePath, {
      mcp: { servers: { rea: openCodeRegistration, peer: openCodePeer } },
    });
    const run = (cwd: string, ...arguments_: string[]) =>
      cli.run({
        arguments: ["uninstall", ...arguments_, "--json"],
        environment,
        cwd,
      });

    const ordinary = await run(project);
    expect(ordinary.exitCode, ordinary.stdout).toBe(0);
    expect(await readFile(piPath, "utf8")).toBe(piOriginal);
    expect(await readFile(openCodePath, "utf8")).toBe(openCodeOriginal);

    const incompatible = await run(root, "--project", project, "--purge-data");
    expect(incompatible.exitCode, incompatible.stdout).toBe(1);
    expect(await readFile(piPath, "utf8")).toBe(piOriginal);

    const selected = await run(root, "--project", project);
    expect(selected.exitCode, selected.stdout).toBe(0);
    expect(selected.json).toMatchObject({
      status: "complete",
      items: expect.arrayContaining([
        expect.objectContaining({
          name: "pi",
          status: "removed",
          configuration_path: piPath,
        }),
        expect.objectContaining({
          name: "opencode",
          status: "removed",
          configuration_path: openCodePath,
        }),
      ]),
    });
    expect(JSON.parse(await readFile(piPath, "utf8"))).toEqual({
      mcpServers: { peer: { command: "unrelated" } },
    });
    expect(JSON.parse(await readFile(openCodePath, "utf8"))).toEqual({
      mcp: { servers: { peer: openCodePeer } },
    });
    expect(await readFile(`${piPath}.rea.backup`, "utf8")).toBe(piOriginal);
    expect(await readFile(`${openCodePath}.rea.backup`, "utf8")).toBe(
      openCodeOriginal,
    );
    expect(await readFile(ancestor, "utf8")).toBe(ancestorOriginal);
    expect(await readFile(piUser, "utf8")).toBe(userOriginal);
  },
);

for (const [scenario, trusted, fallback] of [
  ["Pi trust is denied", false, undefined],
  [
    "a user fallback would become active",
    true,
    { mcpServers: { rea: { command: "unrelated" } } },
  ],
  ["a user fallback is malformed", true, "{ bad"],
] as const) {
  cliTest(`project uninstall is refused when ${scenario}`, async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-project-uninstall-refused-",
    );
    const home = join(root, "home");
    const project = join(root, "selected");
    const environment = await registrationEnvironment(home);
    await put(join(home, ".pi", "agent", "trust.json"), { [project]: trusted });
    const piUser = join(home, ".pi", "agent", "mcp.json");
    const userOriginal =
      fallback === undefined ? undefined : await put(piUser, fallback);
    const piPath = join(project, ".pi", "mcp.json");
    const original = await put(piPath, { mcpServers: { rea: piRegistration } });

    const result = await cli.run({
      arguments: ["uninstall", "--project", project, "--json"],
      environment,
      cwd: root,
    });
    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.json).toMatchObject({
      status: "failed",
      items: expect.arrayContaining([
        expect.objectContaining({ name: "pi", status: "failed" }),
      ]),
    });
    expect(await readFile(piPath, "utf8")).toBe(original);
    await expect(readFile(`${piPath}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (userOriginal !== undefined)
      expect(await readFile(piUser, "utf8")).toBe(userOriginal);
  });
}

for (const scope of ["outside", "user"] as const) {
  cliTest.skipIf(process.platform === "win32")(
    `project uninstall refuses a registration symlink to the ${scope} configuration`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-project-uninstall-link-");
      const home = join(root, "home");
      const project = join(root, "selected");
      const external =
        scope === "outside"
          ? join(root, "elsewhere", "opencode.json")
          : join(home, ".config", "opencode", "opencode.json");
      const environment = await registrationEnvironment(home);
      const original = await put(external, {
        mcp: { servers: { rea: openCodeRegistration } },
      });
      await mkdir(project);
      const link = join(project, "opencode.json");
      await symlink(external, link);

      const result = await cli.run({
        arguments: ["uninstall", "--project", project, "--json"],
        environment,
        cwd: root,
      });
      expect(result.exitCode, result.stdout).toBe(1);
      expect(result.json).toMatchObject({
        status: "failed",
        items: expect.arrayContaining([
          expect.objectContaining({
            name: "opencode",
            status: "failed",
            detail: expect.stringContaining(
              scope === "outside"
                ? "outside the project directory"
                : "aliases user configuration",
            ),
          }),
        ]),
      });
      expect(await readFile(external, "utf8")).toBe(original);
      await expect(readFile(`${link}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
}

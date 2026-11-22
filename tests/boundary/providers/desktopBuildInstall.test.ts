import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { readDesktopBuildFacts } from "../../../src/desktop/DesktopBuildDoctorFacts.js";
import { defaultBuildComputerArchive } from "../../../src/desktop/BuildComputerEnvironment.js";
import { ArtifactResourceScope } from "../../../src/resources/index.js";
import {
  expandDesktopExec,
  parseDesktopEntry,
  tokenizeDesktopExec,
} from "../../../src/domain/desktop/desktopEntry.js";
import { DESKTOP_LAUNCH_CASES } from "../../../src/domain/desktop/desktopLaunchSyntax.fixture.js";
import {
  BUILD_NODE_VERSION,
  renderBuildBundle,
} from "../../../src/domain/desktop/appBuild.js";
import {
  request,
  localPayload,
  text,
  appImageRequest,
  tarballRequest,
} from "../../../src/domain/desktop/appBuild.fixture.js";

const execute = promisify(execFile);

/** Run a rendered download install as the computer would, with its absolute folders moved under `root`. */
const runDownloadInstall = async (
  bundle: ReturnType<typeof renderBuildBundle>,
  root: string,
) => {
  const environment = join(root, "env");
  const moved = (content: string) =>
    content
      .replaceAll("/opt/rea-apps", join(root, "opt/rea-apps"))
      .replaceAll("/usr/local/share", join(root, "local-share"));
  for (const file of bundle.files) {
    const path = file.path.replace(`envs/${bundle.name}/`, "");
    if (typeof file.content !== "string" || path === file.path) continue;
    await mkdir(dirname(join(environment, path)), { recursive: true });
    await writeFile(join(environment, path), moved(file.content));
  }
  return execute("sh", ["install-download.sh"], { cwd: environment });
};

const STUB_APPIMAGE = `#!/bin/sh
[ "$1" = "--appimage-extract" ] || exit 9
mkdir -p squashfs-root
printf '#!/bin/sh\\necho draw.io\\n' > squashfs-root/AppRun
chmod 700 squashfs-root/AppRun
printf '%s\\n' '[Desktop Entry]' 'Name=draw.io' 'Exec=drawio %U' 'TryExec=drawio' 'Icon=drawio' '' '[Desktop Action New]' 'Exec="drawio" --new-window' > squashfs-root/drawio.desktop
printf '<svg/>\\n' > squashfs-root/drawio.svg
`;

/** A tarball holding the program and a link out of the folder: a hardlink to `<outside>/passwd` then a file written through it, or a symlink to `<outside>`. */
const CRAFTED_TARBALL = `
import io, sys, tarfile
path, outside, link = sys.argv[1:4]

def add(archive, name, data=None, **fields):
    member = tarfile.TarInfo(name)
    for key, value in fields.items():
        setattr(member, key, value)
    member.size = 0 if data is None else len(data)
    archive.addfile(member, None if data is None else io.BytesIO(data))

with tarfile.open(path, "w:gz") as archive:
    add(archive, "notes-2.0/bin/notes", b"#!/bin/sh\\n", mode=0o755)
    if link == "hardlink":
        add(archive, "notes-2.0/etc", type=tarfile.LNKTYPE, linkname=outside + "/passwd")
        add(archive, "notes-2.0/etc", b"overwritten\\n")
    else:
        add(archive, "notes-2.0/etc", type=tarfile.SYMTYPE, linkname=outside)
`;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A temporary root with the environment folder's `vendor` folder, where agentenv puts a download. */
const stage = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  await mkdir(join(root, "env/vendor"), { recursive: true });
  return root;
};

describe("download install scripts", () => {
  it("extracts an AppImage under its folder and installs its own entry with an absolute Exec, its icon and no TryExec", async () => {
    const root = await stage("rea-appimage-install-");
    const image = join(root, "env/vendor/app.AppImage");
    await writeFile(image, STUB_APPIMAGE);
    await chmod(image, 0o755);
    await runDownloadInstall(
      renderBuildBundle(appImageRequest("drawio"), localPayload),
      root,
    );

    const appRun = join(root, "opt/rea-apps/drawio/squashfs-root/AppRun");
    expect(
      await readFile(join(root, "local-share/applications/drawio.desktop"), {
        encoding: "utf8",
      }),
    ).toBe(
      `[Desktop Entry]\nName=draw.io\nExec=${appRun} %U\nIcon=drawio\n\n[Desktop Action New]\nExec=${appRun} --new-window\n`,
    );
    expect(
      await exists(
        join(root, "local-share/icons/hicolor/scalable/apps/drawio.svg"),
      ),
    ).toBe(true);
    // The session user runs what root extracted.
    expect((await stat(appRun)).mode & 0o055).toBe(0o055);
    expect(await exists(image)).toBe(false);
  });

  it("fails the build when the AppImage ships no entry by the requested name, naming those it ships", async () => {
    const root = await stage("rea-appimage-entry-");
    const image = join(root, "env/vendor/app.AppImage");
    await writeFile(image, STUB_APPIMAGE);
    await chmod(image, 0o755);
    const failed = await runDownloadInstall(
      renderBuildBundle(appImageRequest("com.example.Other"), localPayload),
      root,
    ).then(
      () => undefined,
      (error: unknown) => error as { stderr: string },
    );
    expect(failed?.stderr).toContain("com.example.Other.desktop");
    expect(failed?.stderr).toContain("drawio.desktop");
  });

  it.each(DESKTOP_LAUNCH_CASES)(
    "replaces only the executable in an AppImage entry with $name",
    async ({ prefix, program, suffix }) => {
      const root = await stage("rea-appimage-env-");
      const image = join(root, "env/vendor/app.AppImage");
      await writeFile(
        image,
        STUB_APPIMAGE.replace(
          "'Exec=drawio %U'",
          () => `'Exec=${prefix}${program}${suffix}'`,
        ),
      );
      await chmod(image, 0o755);
      await runDownloadInstall(
        renderBuildBundle(appImageRequest("drawio"), localPayload),
        root,
      );

      const appRun = join(root, "opt/rea-apps/drawio/squashfs-root/AppRun");
      expect(
        await readFile(
          join(root, "local-share/applications/drawio.desktop"),
          "utf8",
        ),
      ).toContain(`\nExec=${prefix}${appRun}${suffix}\n`);
    },
  );

  it("unpacks a tarball without xz under its folder and installs the entry REA wrote for its program", async () => {
    const root = await stage("rea-tarball-install-");
    const program = join(root, "src/notes-2.0/bin/notes");
    await mkdir(dirname(program), { recursive: true });
    await writeFile(program, "#!/bin/sh\necho notes\n");
    await chmod(program, 0o755);
    await execute("tar", [
      "-cJf",
      join(root, "env/vendor/app.tar"),
      "-C",
      join(root, "src"),
      "notes-2.0",
    ]);
    await runDownloadInstall(
      renderBuildBundle(tarballRequest("notes-2.0/bin/notes"), localPayload),
      root,
    );

    const installed = join(
      root,
      "opt/rea-apps/org.example.Notes/notes-2.0/bin/notes",
    );
    expect(await readFile(installed, "utf8")).toBe("#!/bin/sh\necho notes\n");
    expect(
      await readFile(
        join(root, "local-share/applications/org.example.Notes.desktop"),
        "utf8",
      ),
    ).toContain(`Exec=${installed} %F\n`);
    expect(await exists(join(root, "env/vendor/app.tar"))).toBe(false);

    const missing = await stage("rea-tarball-program-");
    await execute("tar", [
      "-cJf",
      join(missing, "env/vendor/app.tar"),
      "-C",
      join(root, "src"),
      "notes-2.0",
    ]);
    const failed = await runDownloadInstall(
      renderBuildBundle(tarballRequest("notes-2.0/notes"), localPayload),
      missing,
    ).then(
      () => undefined,
      (error: unknown) => error as { stderr: string },
    );
    expect(failed?.stderr).toContain("notes-2.0/notes");
    expect(failed?.stderr).toContain("notes-2.0");
  });
});

it("preserves Exec key spacing and line endings while removing TryExec", async () => {
  const root = await stage("rea-appimage-spaced-");
  const image = join(root, "env/vendor/app.AppImage");
  const source = join(root, "source.desktop");
  await writeFile(
    source,
    '[Desktop Entry]\r\nExec = drawio %U\r\n  TryExec =drawio\r\n\r\n[Desktop Action New]\r\nExec="drawio" --new-window',
  );
  await writeFile(
    image,
    STUB_APPIMAGE + `cp -- "${source}" squashfs-root/drawio.desktop\n`,
  );
  await chmod(image, 0o755);
  await runDownloadInstall(
    renderBuildBundle(appImageRequest("drawio"), localPayload),
    root,
  );

  const appRun = join(root, "opt/rea-apps/drawio/squashfs-root/AppRun");
  expect(
    await readFile(
      join(root, "local-share/applications/drawio.desktop"),
      "utf8",
    ),
  ).toBe(
    `[Desktop Entry]\r\nExec = ${appRun} %U\r\n\r\n[Desktop Action New]\r\nExec=${appRun} --new-window`,
  );
});

it("installs the effective AppImage launcher and action keys while keeping extension fields", async () => {
  const root = await stage("rea-appimage-effective-entry-");
  const image = join(root, "env/vendor/app.AppImage");
  const source = join(root, "source.desktop");
  const desktop = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Draw",
    'Exec="overridden',
    "Icon=earlier",
    "Actions=New;",
    "TryExec=earlier",
    "[Desktop Action New]",
    "Name=New Window",
    'Exec="overridden-action',
    "[X-Extension]",
    'Exec="extension-data',
    "TryExec=extension-data",
    "[Desktop Entry]",
    "Exec=drawio --current %U",
    "Icon=current",
    "TryExec=current",
    "[Desktop Action New]",
    "Exec=drawio --new-window",
    "",
  ].join("\n");
  await writeFile(source, desktop);
  await writeFile(
    image,
    STUB_APPIMAGE +
      `cp -- "${source}" squashfs-root/drawio.desktop\n` +
      "printf 'earlier' > squashfs-root/earlier.svg\n" +
      "printf 'current' > squashfs-root/current.svg\n",
    { mode: 0o755 },
  );

  await runDownloadInstall(
    renderBuildBundle(appImageRequest("drawio"), localPayload),
    root,
  );

  const appRun = join(root, "opt/rea-apps/drawio/squashfs-root/AppRun");
  expect(
    await readFile(
      join(root, "local-share/applications/drawio.desktop"),
      "utf8",
    ),
  ).toBe(
    desktop
      .replace("TryExec=earlier\n", "")
      .replace("TryExec=current\n", "")
      .replace("Exec=drawio --current", `Exec=${appRun} --current`)
      .replace("Exec=drawio --new-window", `Exec=${appRun} --new-window`),
  );
  const icons = join(root, "local-share/icons/hicolor/scalable/apps");
  expect(await readFile(join(icons, "current.svg"), "utf8")).toBe("current");
  expect(await exists(join(icons, "earlier.svg"))).toBe(false);
});

it.each([
  ['env "drawio %U', "unterminated quote"],
  ["env -i", "missing program"],
  ["env --chdir= drawio %U", "missing env chdir directory"],
  ["env --unset= drawio %U", "invalid env unset name"],
])("rejects a malformed AppImage Exec value %s", async (exec, reason) => {
  const root = await stage("rea-appimage-invalid-exec-");
  const image = join(root, "env/vendor/app.AppImage");
  await writeFile(
    image,
    STUB_APPIMAGE.replace("'Exec=drawio %U'", () => `'Exec=${exec}'`),
  );
  await chmod(image, 0o755);
  await expect(
    runDownloadInstall(
      renderBuildBundle(appImageRequest("drawio"), localPayload),
      root,
    ),
  ).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
});

describe("download install scripts and archive links", () => {
  it("refuses a tarball whose links point outside its folder, leaving the files they name untouched", async () => {
    for (const link of ["hardlink", "symlink"]) {
      const root = await stage(`rea-tarball-${link}-`);
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "passwd"), "kept\n");
      await execute("python3", [
        "-I",
        "-c",
        CRAFTED_TARBALL,
        join(root, "env/vendor/app.tar"),
        outside,
        link,
      ]);
      const failed = await runDownloadInstall(
        renderBuildBundle(tarballRequest("notes-2.0/bin/notes"), localPayload),
        root,
      ).then(
        () => undefined,
        (error: unknown) => error as { stderr: string },
      );

      expect(await readFile(join(outside, "passwd"), "utf8"), link).toBe(
        "kept\n",
      );
      const placed = join(root, "opt/rea-apps/org.example.Notes/notes-2.0/etc");
      expect(
        await lstat(placed).then(
          (entry) => entry.isSymbolicLink() || entry.nlink > 1,
          () => false,
        ),
        link,
      ).toBe(false);
      expect(failed?.stderr ?? "", link).toContain("notes-2.0/etc");
    }
  });
});

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

it.each([
  { folder: "REA Build", link: null, cached: false, problem: null },
  { folder: "runtime", link: "cli.mjs", cached: false, problem: null },
  {
    folder: ".runtime",
    link: null,
    cached: false,
    problem: "visible top folder",
  },
  {
    folder: "runtime",
    link: "missing.mjs",
    cached: true,
    problem: "regular file supplied by the archive",
  },
])(
  "agrees on build runtime archive readiness for %j",
  async ({ folder, link, cached, problem }) => {
    const root = await createTestTempDirectory("rea-launcher-layout-");
    const nodeDir = join(
      root,
      "node-src",
      `node-v${BUILD_NODE_VERSION}-linux-x64`,
      "bin",
    );
    const payloadDir = join(root, "payload-src", folder, "scripts");
    await mkdir(nodeDir, { recursive: true });
    await mkdir(payloadDir, { recursive: true });
    const marker = join(root, "node-args");
    const entrypoint = "export const marker = 'rea-entrypoint';\n";
    await writeFile(
      join(nodeDir, "node"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(marker)}\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(payloadDir, "..", "package.json"),
      JSON.stringify({ version: PRODUCT_IDENTITY.packageVersion }),
    );
    if (link === null) await writeFile(join(payloadDir, "rea.mjs"), entrypoint);
    else {
      if (problem === null) await writeFile(join(payloadDir, link), entrypoint);
      await symlink(link, join(payloadDir, "rea.mjs"));
    }
    await execute("tar", [
      "-cJf",
      join(root, "node-amd64.tar.xz"),
      "-C",
      join(root, "node-src"),
      `node-v${BUILD_NODE_VERSION}-linux-x64`,
    ]);
    const archive = join(root, "rea-payload.tar");
    await execute("tar", [
      "-cf",
      archive,
      "-C",
      join(root, "payload-src"),
      folder,
    ]);
    const resources = new ArtifactResourceScope();
    const environment = {
      HOME: root,
      USERPROFILE: root,
      PATH: "",
      XDG_CACHE_HOME: join(root, "cache"),
      ...(cached ? {} : { REA_BUILD_COMPUTER_REA_ARCHIVE: archive }),
    };
    if (cached) {
      const cachePath = defaultBuildComputerArchive(environment, "linux");
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, await readFile(archive));
    }
    try {
      const facts = await readDesktopBuildFacts({
        environment,
        platform: "linux",
        resources,
        signal: new AbortController().signal,
        run: async (command, args) => {
          const { stdout, stderr } = await execute(command, args);
          return {
            stdout,
            stderr,
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr),
          };
        },
        clientIds: [],
        registrations: async () => [],
      });
      expect(facts.archive.status).toBe(
        problem === null ? "current" : "invalid",
      );
      if (problem !== null) {
        expect(facts.archive.detail).toContain(problem);
        expect(facts.archive.detail).toContain(PRODUCT_IDENTITY.packageVersion);
      }
    } finally {
      await resources.close();
    }
    const bundle = renderBuildBundle(
      request({ kind: "archive", package: "mousepad", extra_packages: [] }),
      localPayload,
    );
    const script = text(bundle.files, "envs/mousepad/install-rea.sh")
      .replaceAll("/opt/rea", join(root, "opt/rea"))
      .replaceAll("/usr/local/bin", join(root, "bin"));
    await mkdir(join(root, "bin"), { recursive: true });
    const scriptPath = join(root, "install-rea.sh");
    await writeFile(scriptPath, script);
    const installed = execute("sh", [scriptPath], { cwd: root });
    if (problem !== null) {
      await expect(installed).rejects.toMatchObject({
        stderr: expect.stringContaining(problem),
      });
      return;
    }
    await installed;

    const linked = join(root, "opt/rea/rea.mjs");
    expect(await readlink(linked)).toBe(
      join(root, "opt/rea/payload", folder, "scripts/rea.mjs"),
    );
    expect(await readFile(linked, "utf8")).toBe(entrypoint);
    await execute(join(root, "bin/rea"), ["--version"]);
    expect(await readFile(marker, "utf8")).toBe(`${linked}\n--version\n`);
  },
);

describe("installed launch paths", () => {
  it.each([
    {
      name: "direct command",
      prefix: "",
      displayName: Buffer.from("Typora"),
      valid: true,
    },
    {
      name: "wrapped command with a literal replacement character",
      prefix: "/usr/bin/env -- REA_TEST_ENV=selected ",
      displayName: Buffer.from("Typora \uFFFD"),
      valid: true,
    },
    {
      name: "entry containing malformed UTF-8",
      prefix: "",
      displayName: Buffer.from([0xff]),
      valid: false,
    },
  ])(
    "applies the shared Electron launch policy for $name",
    async ({ prefix, displayName, valid }) => {
      const bundle = renderBuildBundle(
        {
          ...request({
            kind: "archive",
            package: "typora",
            extra_packages: [],
          }),
          desktop_entry: "typora.desktop",
          electron: true,
        },
        localPayload,
      );
      const root = await createTestTempDirectory("rea-electron-launch-");
      const runtime = join(root, "opt/rea/payload/rea");
      const policy = join(runtime, "dist/domain/desktop/appExportInstall.js");
      await mkdir(dirname(policy), { recursive: true });
      const launcher = join(runtime, "scripts/rea.mjs");
      await mkdir(dirname(launcher), { recursive: true });
      await writeFile(launcher, "");
      await symlink(launcher, join(root, "opt/rea/rea.mjs"));
      const unrelatedPolicy = join(
        root,
        "opt/rea/payload/unrelated/dist/domain/desktop/appExportInstall.js",
      );
      await mkdir(dirname(unrelatedPolicy), { recursive: true });
      await writeFile(unrelatedPolicy, "");
      const source = fileURLToPath(
        new URL(
          "../../../src/domain/desktop/appExportInstall.ts",
          import.meta.url,
        ),
      );
      await writeFile(
        policy,
        `export { adjustInstalledDesktopText } from ${JSON.stringify(source)};\n`,
      );
      const applications = join(root, "share/applications");
      await mkdir(applications, { recursive: true });
      const desktop = join(applications, "typora.desktop");
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      const app = join(bin, "typora");
      await writeFile(app, '#!/bin/sh\nprintf "%s\\n" "$REA_TEST_ENV" "$@"\n', {
        mode: 0o755,
      });
      const exec = `${prefix}${app} --title=sample -- APP_MODE=argument %U`;
      const original = Buffer.concat([
        Buffer.from("[Desktop Entry]\nType=Application\nName="),
        displayName,
        Buffer.from(
          `\nExec=${exec}\n[Desktop Action New]\nName=New Window\nExec=typora --new-window\n`,
        ),
      ]);
      await writeFile(desktop, original);
      await writeFile(
        join(bin, "node"),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import tsx "$@"\n`,
      );
      await chmod(join(bin, "node"), 0o755);
      const script = text(
        bundle.files,
        "envs/typora/prepare-electron-launch.sh",
      )
        .replaceAll("/opt/rea", join(root, "opt/rea"))
        .replaceAll("/usr/local/bin", bin);
      const scriptPath = join(root, "prepare-electron-launch.sh");
      await writeFile(scriptPath, script);
      await chmod(scriptPath, 0o755);
      const prepared = execute("sh", [scriptPath], {
        cwd: process.cwd(),
        env: { ...process.env, XDG_DATA_DIRS: join(root, "share") },
      });
      if (!valid) {
        await expect(prepared).rejects.toMatchObject({
          stderr: expect.stringContaining("is not valid UTF-8"),
        });
        expect((await readFile(desktop)).equals(original)).toBe(true);
        return;
      }
      await prepared;

      const adjusted = await readFile(desktop, "utf8");
      expect(adjusted).toBe(
        original
          .toString("utf8")
          .replace(
            `Exec=${exec}`,
            `Exec=${prefix}${app} --no-sandbox --title=sample -- APP_MODE=argument %U`,
          ),
      );
      const parsed = parseDesktopEntry(adjusted);
      if (!parsed.ok) throw new Error(parsed.error);
      const tokens = tokenizeDesktopExec(parsed.value.exec ?? "");
      if (!tokens.ok) throw new Error(tokens.error);
      const argv = expandDesktopExec(
        tokens.value,
        { name: "Typora", icon: null, location: desktop },
        [],
      );
      const { stdout } = await execute(argv[0]!, argv.slice(1), {
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(stdout).toBe(
        `${prefix.length === 0 ? "" : "selected"}\n--no-sandbox\n--title=sample\n--\nAPP_MODE=argument\n`,
      );
    },
  );
});

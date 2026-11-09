import { describe, expect, it } from "vitest";

import { PACKAGE_METADATA } from "../../generatedPackageMetadata.js";
import {
  BUILD_NODE_VERSION,
  BUILD_PACKAGE_FILE,
  buildSourceSchema,
  extraPackagesOf,
  renderBuildBundle,
} from "./appBuild.js";
import {
  request,
  localPayload,
  text,
  DRAWIO_URL,
  DRAWIO_SHA256,
  NOTES_URL,
  appImageRequest,
  tarballRequest,
} from "./appBuild.fixture.js";

describe("build bundle renderer", () => {
  it("installs an archive package, opens it on demand and adds REA in a build-only layer", () => {
    const bundle = renderBuildBundle(
      request({ kind: "archive", package: "mousepad", extra_packages: [] }),
      localPayload,
    );
    expect(bundle.name).toBe("mousepad");
    expect(bundle.files.map((file) => file.path).sort()).toEqual([
      "envs/mousepad/env.toml",
      "envs/mousepad/install-rea.sh",
      "envs/mousepad/mousepad_app.py",
      "envs/mousepad/rea-payload.tar",
      "tasks/smoke.json",
    ]);
    expect(
      bundle.files.find((file) => file.path.endsWith("rea-payload.tar"))
        ?.content,
    ).toEqual({ copyFrom: "/builds/rea-prod.tar.xz" });
    const module = text(bundle.files, "envs/mousepad/mousepad_app.py");
    expect(module).toContain(
      'packages=Packages(apt=["mousepad", "libgtk-3-bin", "dconf-cli"])',
    );
    expect(module).toContain(
      `launch=Launch(at="demand", command=["sh", "-c", "cd \\"$HOME\\" 2>/dev/null; exec gtk-launch 'org.xfce.mousepad'"]),`,
    );
    expect(module).toContain('"arch": ["amd64", "arm64"]');
    expect(module).toContain(
      `Download(url="https://nodejs.org/dist/v${BUILD_NODE_VERSION}/node-v${BUILD_NODE_VERSION}-linux-x64.tar.xz", sha256="6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6", to="node-amd64.tar.xz", arch="amd64")`,
    );
    expect(module).toContain(
      'sha256="dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e", to="node-arm64.tar.xz", arch="arm64"',
    );
    expect(module).toContain('run=[RunScript(script="install-rea.sh")]');
    // Building needs no seed and no data hooks.
    expect(module).not.toMatch(/paths=|@add_data|@get_data|@reset_data/u);
    expect(text(bundle.files, "envs/mousepad/env.toml")).toContain(
      'module = "mousepad_app.py:Mousepad"',
    );
    expect(JSON.parse(text(bundle.files, "tasks/smoke.json"))).toEqual([
      { id: "env", type: "deploy_env", env_id: "mousepad" },
    ]);
    const script = text(bundle.files, "envs/mousepad/install-rea.sh");
    expect(script).toContain("/opt/rea/payload/*/scripts/rea.mjs");
    expect(script).toContain(
      `/opt/rea/node-v${BUILD_NODE_VERSION}-linux-*/bin/node`,
    );
    expect(script).toContain("exec /usr/local/bin/node /opt/rea/rea.mjs");
  });

  it("pins the Node.js release REA itself pins", () => {
    expect(BUILD_NODE_VERSION).toBe(PACKAGE_METADATA.pinnedNodeVersion);
  });
});

describe("build bundle install sources", () => {
  it("declares a vendor apt repository with its key file in the environment folder", () => {
    const key = Buffer.from(
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n-----END PGP PUBLIC KEY BLOCK-----\n",
    );
    const bundle = renderBuildBundle(
      {
        ...request({
          kind: "apt_repository",
          package: "geany",
          uri: "https://ppa.launchpadcontent.net/geany-dev/ppa/ubuntu",
          suite: "noble",
          components: ["main"],
          key_file: "/keys/geany.asc",
        }),
        desktop_entry: "geany",
        window_class: "Geany",
      },
      localPayload,
      key,
    );
    const module = text(bundle.files, "envs/geany/geany_app.py");
    expect(module).toContain(
      'sources=[AptSource(apt="https://ppa.launchpadcontent.net/geany-dev/ppa/ubuntu", suite="noble", components=["main"], key="apt-keys/geany.asc")],',
    );
    expect(module).toContain(
      'window={"class": "Geany"}, ready=Ready(window=True)',
    );
    const copied = bundle.files.find(
      (file) => file.path === "envs/geany/apt-keys/geany.asc",
    )?.content;
    expect(copied instanceof Uint8Array && key.equals(copied)).toBe(true);
  });

  it("installs an archive package's extra packages beside it", () => {
    const bundle = renderBuildBundle(
      request({
        kind: "archive",
        package: "freeplane",
        extra_packages: ["openjdk-17-jre"],
      }),
      localPayload,
    );
    expect(text(bundle.files, "envs/mousepad/mousepad_app.py")).toContain(
      'packages=Packages(apt=["freeplane", "openjdk-17-jre", "libgtk-3-bin", "dconf-cli"])',
    );
  });

  it("downloads a .deb for its architecture and installs it after its dependencies", () => {
    const sha256 = "a".repeat(64);
    const bundle = renderBuildBundle(
      request({
        kind: "package_file",
        url: "https://downloads.example.com/varicad.deb",
        sha256,
        architecture: "amd64",
        dependencies: ["libgl1"],
      }),
      {
        kind: "download",
        url: "https://releases.example.com/rea.tar.xz",
        sha256: "b".repeat(64),
      },
    );
    const module = text(bundle.files, "envs/mousepad/mousepad_app.py");
    expect(module).toContain(
      'packages=Packages(apt=["libgl1", "libgtk-3-bin", "dconf-cli"])',
    );
    expect(module).toContain(
      `Download(url="https://downloads.example.com/varicad.deb", sha256="${sha256}", to="vendor/package.deb", arch="amd64")`,
    );
    expect(module).toContain(
      `Download(url="https://releases.example.com/rea.tar.xz", sha256="${"b".repeat(64)}", to="rea-payload.tar")`,
    );
    expect(module).toContain('"arch": ["amd64"]');
    expect(module).not.toContain('to="node-arm64.tar.xz"');
    // REA's layer keeps the .deb for the capture before the install removes it.
    expect(module).toContain(
      'run=[RunScript(script="install-rea.sh"), RunScript(script="install-package.sh")]',
    );
    expect(text(bundle.files, "envs/mousepad/install-rea.sh")).toContain(
      `cp vendor/package.deb ${BUILD_PACKAGE_FILE}`,
    );
    expect(BUILD_PACKAGE_FILE).toBe("/opt/rea/package.deb");
    expect(text(bundle.files, "envs/mousepad/install-package.sh")).toContain(
      "dpkg -i 'vendor/package.deb'",
    );
    expect(
      bundle.files.some((file) => file.path.endsWith("rea-payload.tar")),
    ).toBe(false);
  });

  it("admits only what agentenv can install from", () => {
    const parse = (value: unknown) => buildSourceSchema.safeParse(value);
    expect(
      parse({
        kind: "request",
        desktop_entry: "../evil",
        install: { kind: "archive", package: "mousepad" },
      }).success,
    ).toBe(false);
    expect(
      parse({
        kind: "request",
        desktop_entry: "mousepad",
        install: {
          kind: "package_file",
          url: "https://user@example.com/a.deb",
          sha256: "a".repeat(64),
          architecture: "amd64",
        },
      }).success,
    ).toBe(false);
    expect(
      parse({
        kind: "request",
        desktop_entry: "mousepad",
        install: {
          kind: "apt_repository",
          package: "geany",
          uri: "ftp://example.com/ubuntu",
          suite: "noble",
          key_file: "/keys/geany.gpg",
        },
      }).success,
    ).toBe(false);
    expect(parse({ kind: "bundle", path: "relative/bundle" }).success).toBe(
      false,
    );
    expect(parse({ kind: "bundle", path: "/tmp/bundle" }).success).toBe(true);
  });
});

describe("build bundle download installs", () => {
  it("downloads an AppImage for its architecture and extracts it after REA's layer and before the Electron rewrite", () => {
    const source = appImageRequest("drawio");
    const bundle = renderBuildBundle(source, localPayload);
    const module = text(bundle.files, "envs/drawio/drawio_app.py");
    expect(module).toContain(
      'packages=Packages(apt=["libasound2t64", "libgtk-3-bin", "dconf-cli"])',
    );
    expect(module).toContain(
      `Download(url="${DRAWIO_URL}", sha256="${DRAWIO_SHA256}", to="vendor/app.AppImage", arch="arm64")`,
    );
    expect(module).toContain('"arch": ["arm64"]');
    expect(module).not.toContain('to="node-amd64.tar.xz"');
    // The Electron rewrite edits the desktop entry the extract step installs.
    expect(module).toContain(
      'run=[RunScript(script="install-rea.sh"), RunScript(script="install-download.sh"), RunScript(script="prepare-electron-launch.sh")]',
    );
    expect(module).toContain("exec gtk-launch 'drawio'");
    expect(text(bundle.files, "envs/drawio/install-download.sh")).toContain(
      "--appimage-extract",
    );
    expect(extraPackagesOf(source)).toEqual(["libasound2t64"]);
  });

  it("downloads a tarball and ships the desktop entry REA writes for its program", () => {
    const bundle = renderBuildBundle(
      tarballRequest("notes-2.0/bin/notes"),
      localPayload,
    );
    expect(text(bundle.files, "envs/notes/notes_app.py")).toContain(
      `Download(url="${NOTES_URL}", sha256="${"c".repeat(64)}", to="vendor/app.tar", arch="arm64")`,
    );
    expect(
      text(bundle.files, "envs/notes/applications/org.example.Notes.desktop"),
    ).toBe(
      "[Desktop Entry]\nType=Application\nName=Example Notes\nExec=/opt/rea-apps/org.example.Notes/notes-2.0/bin/notes %F\nTerminal=false\n",
    );
  });

  it("admits a download only by an http or https URL, its SHA-256 and a program inside the archive", () => {
    const install = (fields: Record<string, unknown>) =>
      buildSourceSchema.safeParse({
        kind: "request",
        desktop_entry: "org.example.Notes",
        install: {
          kind: "tarball",
          url: NOTES_URL,
          sha256: "c".repeat(64),
          architecture: "arm64",
          program: "notes-2.0/bin/notes",
          ...fields,
        },
      }).success;
    expect(install({})).toBe(true);
    expect(install({ program: "../bin/sh" })).toBe(false);
    expect(install({ program: "/usr/bin/notes" })).toBe(false);
    expect(install({ program: "notes//notes" })).toBe(false);
    expect(install({ sha256: "C".repeat(64) })).toBe(false);
    expect(install({ url: "ftp://downloads.example.com/notes.tar.xz" })).toBe(
      false,
    );
    expect(install({ name: "Notes\nExec=/bin/sh" })).toBe(false);
    expect(install({ architecture: "armhf" })).toBe(false);
    expect(
      buildSourceSchema.safeParse({
        kind: "request",
        desktop_entry: "drawio",
        install: {
          kind: "appimage",
          url: "https://user:secret@example.com/drawio.AppImage",
          sha256: DRAWIO_SHA256,
          architecture: "arm64",
        },
      }).success,
    ).toBe(false);
  });
});

describe("Electron launch rendering", () => {
  it("rewrites an Electron desktop command with the shared launch policy", async () => {
    const bundle = renderBuildBundle(
      {
        ...request({ kind: "archive", package: "typora", extra_packages: [] }),
        desktop_entry: "typora.desktop",
        electron: true,
      },
      localPayload,
    );
    expect(bundle.files.map((file) => file.path).sort()).toContain(
      "envs/typora/prepare-electron-launch.sh",
    );
    const module = text(bundle.files, "envs/typora/typora_app.py");
    expect(module).toContain(
      `launch=Launch(at="demand", command=["sh", "-c", "cd \\"$HOME\\" 2>/dev/null; exec gtk-launch 'typora'"]),`,
    );
    expect(module).toContain(
      'run=[RunScript(script="install-rea.sh"), RunScript(script="prepare-electron-launch.sh")]',
    );
    const plain = renderBuildBundle(
      {
        ...request({ kind: "archive", package: "typora", extra_packages: [] }),
        desktop_entry: "typora",
        electron: false,
      },
      localPayload,
    );
    expect(
      plain.files.some((file) =>
        file.path.endsWith("prepare-electron-launch.sh"),
      ),
    ).toBe(false);
  });
});

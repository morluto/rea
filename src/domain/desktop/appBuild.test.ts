import { describe, expect, it } from "vitest";

import { PACKAGE_METADATA } from "../../generatedPackageMetadata.js";
import {
  BUILD_NODE_VERSION,
  buildSourceSchema,
  renderBuildBundle,
  type BuildBundleFile,
  type BuildRequest,
} from "./appBuild.js";

const request = (install: BuildRequest["install"]): BuildRequest => ({
  kind: "request",
  desktop_entry: "org.xfce.mousepad.desktop",
  install,
});
const localPayload = { kind: "file", path: "/builds/rea-prod.tar.xz" } as const;
const text = (files: readonly BuildBundleFile[], path: string): string => {
  const content = files.find((file) => file.path === path)?.content;
  if (typeof content !== "string") throw new Error(`no text file ${path}`);
  return content;
};

describe("build bundle renderer", () => {
  it("installs an archive package, opens it on demand and adds REA in a build-only layer", () => {
    const bundle = renderBuildBundle(
      request({ kind: "archive", package: "mousepad" }),
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
      'packages=Packages(apt=["mousepad", "libgtk-3-bin"])',
    );
    expect(module).toContain(
      'launch=Launch(at="demand", command=["gtk-launch", "org.xfce.mousepad"]),',
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
      'packages=Packages(apt=["libgl1", "libgtk-3-bin"])',
    );
    expect(module).toContain(
      `Download(url="https://downloads.example.com/varicad.deb", sha256="${sha256}", to="vendor/package.deb", arch="amd64")`,
    );
    expect(module).toContain(
      `Download(url="https://releases.example.com/rea.tar.xz", sha256="${"b".repeat(64)}", to="rea-payload.tar")`,
    );
    expect(module).toContain('"arch": ["amd64"]');
    expect(module).not.toContain('to="node-arm64.tar.xz"');
    expect(module).toContain(
      'run=[RunScript(script="install-package.sh"), RunScript(script="install-rea.sh")]',
    );
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

import type { BuildBundleFile, BuildRequest } from "./appBuild.js";

export const request = (install: BuildRequest["install"]): BuildRequest => ({
  kind: "request",
  desktop_entry: "org.xfce.mousepad.desktop",
  install,
});
export const localPayload = {
  kind: "file",
  path: "/builds/rea-prod.tar.xz",
} as const;
export const text = (
  files: readonly BuildBundleFile[],
  path: string,
): string => {
  const content = files.find((file) => file.path === path)?.content;
  if (typeof content !== "string") throw new Error(`no text file ${path}`);
  return content;
};

export const DRAWIO_URL =
  "https://github.com/jgraph/drawio-desktop/releases/download/v32.6.10/drawio-arm64-32.6.10.AppImage";
export const DRAWIO_SHA256 =
  "2b3a66339d56a87a346df52b65fc39a342da1b12b5eed80a633c3bb6c031700e";
export const NOTES_URL =
  "https://downloads.example.com/notes-2.0-linux-arm64.tar.xz";

export const appImageRequest = (desktopEntry: string): BuildRequest => ({
  kind: "request",
  desktop_entry: desktopEntry,
  electron: true,
  install: {
    kind: "appimage",
    url: DRAWIO_URL,
    sha256: DRAWIO_SHA256,
    architecture: "arm64",
    extra_packages: ["libasound2t64"],
  },
});

export const tarballRequest = (program: string): BuildRequest => ({
  kind: "request",
  desktop_entry: "org.example.Notes",
  install: {
    kind: "tarball",
    url: NOTES_URL,
    sha256: "c".repeat(64),
    architecture: "arm64",
    program,
    name: "Example Notes",
    extra_packages: [],
  },
});

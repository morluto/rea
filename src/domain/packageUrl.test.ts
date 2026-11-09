import { expect, it } from "vitest";
import {
  cargoPackageUrl,
  golangPackageUrl,
  packageUrlBytes,
} from "./packageUrl.js";

it.each([
  [
    "lowercased Go namespace and name",
    golangPackageUrl("github.com/Azure/go-autorest", "v0.11.29"),
    "pkg:golang/github.com/azure/go-autorest@v0.11.29",
  ],
  [
    "Go path slashes",
    golangPackageUrl("example.com/tool/cmd/tool", "v1.2.3"),
    "pkg:golang/example.com/tool/cmd/tool@v1.2.3",
  ],
  [
    "+incompatible",
    golangPackageUrl("example.com/legacy", "v2.0.0+incompatible"),
    "pkg:golang/example.com/legacy@v2.0.0%2Bincompatible",
  ],
  [
    "(devel)",
    golangPackageUrl("example.com/tool", "(devel)"),
    "pkg:golang/example.com/tool@%28devel%29",
  ],
  [
    "empty version",
    golangPackageUrl("../dependency", ""),
    "pkg:golang/../dependency",
  ],
  [
    "unicode",
    golangPackageUrl("example.com/café", "v1.0.0"),
    "pkg:golang/example.com/caf%C3%A9@v1.0.0",
  ],
  [
    "cargo name",
    cargoPackageUrl("serde", "1.0.210"),
    "pkg:cargo/serde@1.0.210",
  ],
  [
    "cargo slash",
    cargoPackageUrl("foo/bar", "1.0.0"),
    "pkg:cargo/foo%2Fbar@1.0.0",
  ],
] as const)("encodes %s", (_label, actual, expected) => {
  expect(actual).toBe(expected);
});

it.each([
  ["golang", "github.com/Azure/go-autorest", "v0.11.29"],
  ["golang", "example.com/café", "v2.0.0+incompatible"],
  ["golang", "example.com/\u212Aelvin", ""],
  ["cargo", "foo/bar", "1.0.0"],
  ["cargo", "crate😀\uD800", "(devel)"],
] as const)("sizes %s %s exactly", (type, name, version) => {
  const url =
    type === "golang"
      ? golangPackageUrl(name, version)
      : cargoPackageUrl(name, version);
  expect(packageUrlBytes(type, name, version)).toBe(
    Buffer.byteLength(url, "utf8"),
  );
});

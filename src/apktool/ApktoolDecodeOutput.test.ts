import { describe, expect, it } from "vitest";

import {
  parseApktoolYml,
  parseDecodedStrings,
  parseManifestPackage,
} from "./ApktoolDecodeOutput.js";

const REAL_YML = [
  "!!brut.androlib.meta.MetaInfo",
  "apkFileName: probe.apk",
  "compressionType: false",
  "doNotCompress:",
  "- resources.arsc",
  "isFrameworkApk: false",
  "packageInfo:",
  "  forcedPackageId: '127'",
  "  renameManifestPackage: null",
  "sdkInfo:",
  "  minSdkVersion: '24'",
  "  targetSdkVersion: '34'",
  "sharedLibrary: false",
  "sparseResources: false",
  "unknownFiles: {}",
  "usesFramework:",
  "  ids:",
  "  - 1",
  "  tag: null",
  "version: 2.7.0-dirty",
  "versionInfo:",
  "  versionCode: '7'",
  "  versionName: 1.2.3",
  "",
].join("\n");

describe("parseApktoolYml", () => {
  it("projects version and SDK facts from a real apktool.yml", () => {
    expect(parseApktoolYml(REAL_YML)).toEqual({
      versionName: "1.2.3",
      versionCode: "7",
      minSdkVersion: "24",
      targetSdkVersion: "34",
    });
  });

  it("accepts quoted version values some builds emit", () => {
    expect(parseApktoolYml("versionName: '2.0.0'\nversionCode: 45\n")).toEqual({
      versionName: "2.0.0",
      versionCode: "45",
      minSdkVersion: null,
      targetSdkVersion: null,
    });
  });

  it("reports null facts for unrelated YAML", () => {
    expect(parseApktoolYml("version: 2.7.0\n")).toEqual({
      versionName: null,
      versionCode: null,
      minSdkVersion: null,
      targetSdkVersion: null,
    });
  });
});

describe("parseManifestPackage", () => {
  it("reads the package attribute from a decoded manifest", () => {
    const manifest =
      '<?xml version="1.0" encoding="utf-8" standalone="no"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" android:compileSdkVersion="34" package="com.rea.apktool.probe" platformBuildVersionCode="34">';
    expect(parseManifestPackage(manifest)).toBe("com.rea.apktool.probe");
  });

  it("reports null when no package attribute exists", () => {
    expect(parseManifestPackage("<manifest>\n</manifest>\n")).toBeNull();
  });
});

describe("parseDecodedStrings", () => {
  it("projects entries from a real decoded strings.xml", () => {
    const stringsXml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<resources>",
      '    <string name="api_endpoint">https://api.example.com/v1</string>',
      '    <string name="app_name">ApktoolProbe</string>',
      '    <string name="debug_flag">true</string>',
      "</resources>",
      "",
    ].join("\n");
    expect(parseDecodedStrings(stringsXml)).toEqual({
      entries: [
        { name: "api_endpoint", value: "https://api.example.com/v1" },
        { name: "app_name", value: "ApktoolProbe" },
        { name: "debug_flag", value: "true" },
      ],
      unparsedCount: 0,
    });
  });

  it("counts entries with nested markup instead of flattening them", () => {
    const stringsXml =
      '<resources><string name="styled">Hello <b>world</b></string><string name="plain">ok</string></resources>';
    expect(parseDecodedStrings(stringsXml)).toEqual({
      entries: [{ name: "plain", value: "ok" }],
      unparsedCount: 1,
    });
  });

  it("preserves escaped entities verbatim", () => {
    const stringsXml =
      '<resources><string name="escaped">a &amp; b &lt;c&gt;</string></resources>';
    expect(parseDecodedStrings(stringsXml).entries[0]?.value).toBe(
      "a &amp; b &lt;c&gt;",
    );
  });
});

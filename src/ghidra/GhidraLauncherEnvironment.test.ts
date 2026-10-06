import { describe, expect, it } from "vitest";

import { ghidraHeadlessJavaOptions } from "./GhidraLauncher.js";

describe("Ghidra headless JVM environment", () => {
  it("passes Windows paths with spaces to Java's environment parser", () => {
    expect(
      ghidraHeadlessJavaOptions(
        "C:\\REA Runtime\\home",
        "C:\\REA Runtime\\tmp",
        "win32",
      ),
    ).toEqual({
      JDK_JAVA_OPTIONS:
        '"-Duser.home=C:\\REA Runtime\\home" "-Djava.io.tmpdir=C:\\REA Runtime\\tmp" "-XX:-UsePerfData"',
      GHIDRA_HEADLESS_JAVA_OPTIONS: "",
    });
  });

  it.each(["linux", "darwin"] as const)(
    "keeps the %s headless-script option list and clears inherited JDK options",
    (platform) => {
      expect(
        ghidraHeadlessJavaOptions("/tmp/rea/home", "/tmp/rea/tmp", platform),
      ).toEqual({
        JDK_JAVA_OPTIONS: "",
        GHIDRA_HEADLESS_JAVA_OPTIONS:
          "-Duser.home=/tmp/rea/home -Djava.io.tmpdir=/tmp/rea/tmp",
      });
    },
  );

  it.each(["%TEMP%", 'quote"', "amp&", "line\n", "nul\0"])(
    "rejects interpreter metacharacters in either Windows JVM path: %s",
    (suffix) => {
      for (const [home, temp] of [
        [`C:\\runtime\\${suffix}`, "C:\\runtime\\tmp"],
        ["C:\\runtime\\home", `C:\\runtime\\${suffix}`],
      ] as const)
        expect(() => ghidraHeadlessJavaOptions(home, temp, "win32")).toThrow(
          /metacharacters/u,
        );
    },
  );
});

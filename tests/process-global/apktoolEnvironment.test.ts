import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import { ApktoolProvider } from "../../src/apktool/ApktoolProvider.js";
import { execFileOutput } from "../../src/process/ExecFileOutput.js";

vi.mock("../../src/process/ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/process/ExecFileOutput.js")
  >()),
  execFileOutput: vi.fn(async () => ({ stdout: "2.7.0-stub\n", stderr: "" })),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(execFileOutput).mockClear();
});

it.skipIf(process.platform === "win32")(
  "keeps an explicit environment's PATH choice and samples ambient inheritance per operation",
  async () => {
    vi.stubEnv("REA_APKTOOL_COMMAND", "/ambient/initial-apktool");
    vi.stubEnv("REA_APKTOOL_TEST_INHERITED_VALUE", "initial");
    const provider = new ApktoolProvider({ environment: {} });
    onTestFinished(() => provider.close());
    vi.stubEnv("REA_APKTOOL_COMMAND", "/ambient/changed-apktool");
    vi.stubEnv("REA_APKTOOL_TEST_INHERITED_VALUE", "changed");
    await provider.inspectAvailability();
    expect(vi.mocked(execFileOutput).mock.lastCall?.[0]).toBe("apktool");
    expect(vi.mocked(execFileOutput).mock.lastCall?.[2]?.env).toMatchObject({
      REA_APKTOOL_COMMAND: undefined,
      REA_APKTOOL_TEST_INHERITED_VALUE: "changed",
    });
    vi.stubEnv("REA_APKTOOL_TEST_INHERITED_VALUE", undefined);
    await provider.inspectAvailability();
    expect(
      vi.mocked(execFileOutput).mock.lastCall?.[2]?.env
        ?.REA_APKTOOL_TEST_INHERITED_VALUE,
    ).toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "inherits the current default launcher when no environment was selected",
  async () => {
    vi.stubEnv("REA_APKTOOL_COMMAND", "/ambient/initial-apktool");
    const provider = new ApktoolProvider();
    onTestFinished(() => provider.close());
    vi.stubEnv("REA_APKTOOL_COMMAND", "/ambient/later-apktool");
    await provider.inspectAvailability();
    expect(vi.mocked(execFileOutput).mock.lastCall?.[0]).toBe(
      "/ambient/later-apktool",
    );
  },
);

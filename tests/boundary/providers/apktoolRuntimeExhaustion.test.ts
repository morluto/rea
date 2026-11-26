import { chmod, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ApktoolProvider } from "../../../src/apktool/ApktoolProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

const it = test.skipIf(process.platform === "win32");

/** A launcher whose decode prints the given stderr and exits with status 1. */
const failingDecode = async (stderr: string) => {
  const root = await createTestTempDirectory("rea-apktool-oom-");
  const command = join(root, "apktool");
  await writeFile(
    command,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf '2.7.0-dirty\\n'; exit 0; fi
${stderr}
exit 1
`,
    { mode: 0o755 },
  );
  await chmod(command, 0o755);
  const path = join(root, "selected.apk");
  await writeFile(path, "authored target");
  const provider = new ApktoolProvider({
    environment: { REA_APKTOOL_COMMAND: command },
  });
  onTestFinished(() => provider.close());
  const result = await provider.execute({
    operation: "decode_android_resources",
    input: { path, include_strings: true },
  });
  if (result.ok) throw new Error("Expected the decode to fail");
  return projectAnalysisError(result.error);
};

const OOM_LINE = `printf 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space\\n' >&2`;

it("reports the decoder JVM's heap exhaustion as memory, not a target refusal", async () => {
  const projected = await failingDecode(OOM_LINE);
  expect(projected.code).not.toBe("unsupported_target");
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "memory",
      diagnostics: {
        runtime_exhaustion_report: { runtime: "jvm", area: "heap" },
      },
    },
  });
});

it.each([
  ["Metaspace", "metaspace", "memory"],
  ["Requested array size exceeds VM limit", "array-size", "memory"],
  ["unable to create native thread", "native-thread", "capacity"],
])(
  "names the memory area a %s report exhausted",
  async (detail, area, resource) => {
    const projected = await failingDecode(
      `printf 'Exception in thread "main" java.lang.OutOfMemoryError: ${detail}\\n' >&2`,
    );
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        resource,
        diagnostics: {
          runtime_exhaustion_report: { runtime: "jvm", area },
        },
      },
    });
  },
);

it("observes the heap report while output streams, even past the capture allowance", async () => {
  // A stack trace longer than the 4 MiB capture allowance follows the report.
  const projected = await failingDecode(
    `${OOM_LINE}\nhead -c 5000000 /dev/zero | tr '\\0' 'x' >&2`,
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "memory",
      diagnostics: {
        runtime_exhaustion_report: { runtime: "jvm", area: "heap" },
      },
    },
  });
  // The retained stderr tail no longer holds the report; the claim keeps it.
  expect(projected.details).toMatchObject({
    diagnostics: {
      runtime_exhaustion_report: {
        runtime: "jvm",
        area: "heap",
        stream: "stderr",
        line: expect.stringContaining(
          "java.lang.OutOfMemoryError: Java heap space",
        ),
        line_complete: true,
      },
    },
  });
});

it("still attributes an ordinary decode refusal to the target", async () => {
  const projected = await failingDecode(
    `printf 'brut.androlib.AndrolibException: Could not decode the APK\\n' >&2`,
  );
  expect(projected.code).toBe("unsupported_target");
});

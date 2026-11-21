import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  withCommands,
  ExperimentCommandCleanupFailure,
} from "../command-scope.mjs";
import { OwnedCommandFailure } from "../../../dist/process/OwnedCommand.js";
import { createIdentityRecorder } from "./identities.mjs";
import { failureRecord } from "./failure-record.mjs";
import { DarwinProcessOwnershipInspectionError } from "../../../dist/process/DarwinProcessRunTokenReader.js";
import { ArtifactResourceScope } from "../../../dist/resources/index.js";
import {
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "../../../dist/filesystem/OwnedRegularFile.js";

test("retains earlier physical hashes when a later directory read fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-aapt2-partial-hashes-"));
  const files = new ArtifactResourceScope();
  const failure = new Error("later directory unavailable");
  try {
    await writeFile(join(root, "a.txt"), "observed");
    await mkdir(join(root, "z"));
    const { tree } = createIdentityRecorder(files, undefined, {
      directory: async (path, options) => {
        if (path === join(root, "z")) throw failure;
        return readdir(path, options);
      },
    });
    const entries = [];
    await assert.rejects(tree(root, entries), (error) => error === failure);
    assert.deepEqual(entries, [
      {
        path: "a.txt",
        sha256: createHash("sha256").update("observed").digest("hex"),
        bytes: 8,
      },
    ]);
  } finally {
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ["cancelled", "cleanup-completed", "cleanup-failed"])
  test(`publishes only producer-confirmed completed file facts: ${kind}`, async () => {
    const files = new ArtifactResourceScope();
    const value = { sha256: "a".repeat(64), bytes: 7 };
    const outcome =
      kind === "cleanup-failed"
        ? { kind: "failed", cause: new Error("read failed") }
        : { kind: "completed", value };
    const failure =
      kind === "cancelled"
        ? new RegularFileCancelled(
            "selected",
            {},
            { outcome, reason: new Error("cancel during close") },
          )
        : new RegularFileCleanupFailure({
            path: "selected",
            owner: {},
            outcome,
            cleanupCause: new Error("close denied"),
          });
    const { identity } = createIdentityRecorder(files, undefined, {
      hash: async () => {
        throw failure;
      },
    });
    let observed;
    await assert.rejects(
      identity("selected", (fact) => {
        observed = fact;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(observed, kind === "cleanup-failed" ? undefined : value);
    await files.close();
  });

const script = fileURLToPath(new URL("./verify.mjs", import.meta.url));
// The development source loader can emit a Node warning before the receipt.
const terminalReceipt = (stderr) =>
  JSON.parse(stderr.trimEnd().split("\n").at(-1));
for (const diagnostics of [true, false]) {
  test(`cleanup reports exclude inherited environment and live owners (diagnostics: ${diagnostics})`, () => {
    const retainedValue = "UNRELATED_AMBIENT_VALUE=must-not-be-persisted";
    const inspectionFailure = new RegularFileCleanupFailure({
      path: "/proc/123/environ",
      owner: {
        close: async () => {},
        identity: "live-owner-must-not-be-persisted",
      },
      outcome: { kind: "completed", value: retainedValue },
      cleanupCause: new Error("descriptor close failed"),
    });
    const failure = new ExperimentCommandCleanupFailure({
      status: "incomplete",
      reason: "inspection cleanup remains",
      inspectionCleanup: {
        causes: [inspectionFailure],
        failures: [
          { failure: inspectionFailure, cause: new Error("retry failed") },
        ],
      },
    });
    const record = failureRecord(failure, { diagnostics });
    assert.equal(record.cleanup_result.status, "incomplete");
    assert.equal(
      record.cleanup_result.inspection_failures[0].failure.name,
      "RegularFileCleanupFailure",
    );
    assert.equal(
      record.cleanup_result.inspection_failures[0].cause.message,
      "retry failed",
    );
    assert.match(JSON.stringify(record), /descriptor close failed/u);
    assert.doesNotMatch(
      JSON.stringify(record),
      /UNRELATED_AMBIENT_VALUE|must-not-be-persisted/u,
    );
    assert.equal(inspectionFailure.outcome.value, retainedValue);
  });
  test(`command reports retain physical failure and later cancellation (diagnostics: ${diagnostics})`, () => {
    const failure = new OwnedCommandFailure(
      "process",
      "child failed",
      null,
      null,
      {
        cause: new Error("physical process error"),
        cancellation: {
          reason: new Error("operator cancelled during cleanup"),
        },
      },
    );
    const record = failureRecord(failure, { diagnostics });
    assert.equal(record.reason, "process");
    assert.equal(record.cause.message, "physical process error");
    assert.equal(
      record.cancellation.reason.message,
      "operator cancelled during cleanup",
    );
  });
}
for (const nested of [false, true])
  test(`retains native compiler diagnostics only in the complete receipt (nested: ${nested})`, () => {
    const compilerOutcome = {
      outcome: "timed_out",
      code: null,
      signal: "SIGTERM",
      stderr: "COMPILER_EXPANDED_STDERR",
      stderrBytes: 24,
      stderrTruncated: true,
      outputTruncated: true,
      killed: true,
      timeoutMs: 71337,
    };
    const capturedOutput = {
      stdout: "COMPILER_EXPANDED_STDOUT",
      stderr: "COMPILER_CAPTURED_STDERR",
      truncated: true,
    };
    const native = new DarwinProcessOwnershipInspectionError(
      "Compiler reached its deadline",
      { compilerOutcome, capturedOutput },
    );
    const failure = nested
      ? new AggregateError([native], "Preparation failed")
      : native;
    const full = failureRecord(failure);
    const compact = failureRecord(failure, { diagnostics: false });
    const fullNative = nested ? full.errors[0] : full;
    const compactNative = nested ? compact.errors[0] : compact;
    assert.deepEqual(fullNative.compiler_outcome, compilerOutcome);
    assert.deepEqual(fullNative.captured_output, capturedOutput);
    const { stderr: _stderr, ...facts } = compilerOutcome;
    assert.deepEqual(compactNative.compiler_outcome, {
      ...facts,
      stderr_omitted: true,
    });
    assert.equal("captured_output" in compactNative, false);
    assert.doesNotMatch(
      JSON.stringify(compact),
      /COMPILER_(?:EXPANDED|CAPTURED)/u,
    );
  });
test(
  "retains decoded and linked identities in the actual verifier's failed rebuild receipt",
  {
    skip:
      process.platform === "win32"
        ? "POSIX selected executable fixture"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-aapt2-decoded-identity-"));
    const binary = join(root, "producer");
    const framework = join(root, "framework.jar");
    const output = join(root, "result");
    try {
      await writeFile(framework, "selected framework");
      await writeFile(
        binary,
        `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const destination=()=>args[args.indexOf('-o')+1];
if(args[0]==='version') console.log('Android Asset Packaging Tool (aapt) 2.19-fixture');
else if(args[0]==='--version') console.log('3.0.3');
else if(args[0]==='compile'||args[0]==='link') fs.writeFileSync(destination(),'linked fixture');
else if(args[0]==='dump') console.log(args[1]==='badging'?"package: name='com.rea.aapt2.probe' versionCode='7' versionName='1.2.3'":args[1]==='resources'?'string/greeting':args[1]==='strings'?'Hello & welcome; Hallo & willkommen':'TextView');
else if(args[0]==='d') { fs.mkdirSync(destination());fs.writeFileSync(path.join(destination(),'settings.ini'),'decoded settings'); }
else if(args[0]==='b') { console.error('authored rebuild refusal');process.exitCode=9; }
else { console.error('Unmodeled command');process.exitCode=97; }
`,
        { mode: 0o700 },
      );
      await assert.rejects(
        withCommands((run) =>
          run(process.execPath, [
            script,
            "--aapt2",
            binary,
            "--apktool",
            binary,
            "--framework",
            framework,
            "--output",
            output,
          ]),
        ),
      );
      const receipt = JSON.parse(
        await readFile(join(output, "receipt.json"), "utf8"),
      );
      assert.equal(receipt.outcome, "failed");
      assert.equal(receipt.commands.at(-1).arguments[0], "b");
      assert.deepEqual(receipt.retained_command_resources, []);
      if (process.platform !== "win32") {
        assert.equal(receipt.verifier_run.process_lineage.status, "verified");
        assert.deepEqual(receipt.verifier_run.process_lineage.descendants, []);
      }
      assert.deepEqual(receipt.decoded_before, [
        {
          path: "settings.ini",
          bytes: 16,
          sha256: createHash("sha256").update("decoded settings").digest("hex"),
        },
      ]);
      assert.deepEqual(receipt.linked, {
        bytes: 14,
        sha256: createHash("sha256").update("linked fixture").digest("hex"),
      });
      assert(receipt.source.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("persists an admitted preflight failure before any producer starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-aapt2-preflight-"));
  const output = join(root, "result");
  const framework = join(root, "missing-framework.jar");
  try {
    await assert.rejects(
      withCommands((run) =>
        run(process.execPath, [
          script,
          "--aapt2",
          join(root, "missing-aapt2"),
          "--apktool",
          join(root, "missing-apktool"),
          "--framework",
          framework,
          "--output",
          output,
        ]),
      ),
    );
    const receipt = JSON.parse(
      await readFile(join(output, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.outcome, "failed");
    assert.deepEqual(receipt.commands, []);
    assert.equal(receipt.framework.path, framework);
    assert.match(JSON.stringify(receipt.failure), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an occupied output directory without overwriting its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-aapt2-collision-"));
  const marker = join(root, "preserve.txt");
  await writeFile(marker, "caller evidence");
  try {
    await assert.rejects(
      withCommands((run) =>
        run(process.execPath, [
          script,
          "--aapt2",
          "missing-aapt2",
          "--apktool",
          "missing-apktool",
          "--framework",
          "missing.jar",
          "--output",
          root,
        ]),
      ),
      (error) =>
        error.reason === "process" &&
        error.snapshot.stderr.text.includes("EEXIST"),
    );
    assert.equal(await readFile(marker, "utf8"), "caller evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const mode of ["exit", "truncation"])
  test(
    `persists earlier commands and ${mode} diagnostics in a failed verifier receipt`,
    {
      skip:
        process.platform === "win32"
          ? "The selected executable fixture uses a POSIX shebang"
          : false,
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rea-aapt2-failure-"));
      const binary = join(root, "producer");
      const framework = join(root, "framework.jar");
      const output = join(root, "result");
      await writeFile(
        framework,
        "fixture input: compilation fails before linking",
      );
      await writeFile(
        binary,
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'version') ${mode === "exit" ? "console.error('Android Asset Packaging Tool (aapt) 2.19-fixture');" : "console.log('fixture AAPT2');"}
else if (args.length === 1 && args[0] === '--version') console.log('${mode === "exit" ? "2.7.0-dirty" : "3.0.3"}');
else if (args.length === 5 && args[0] === 'compile' && args[1] === '--dir' && args[3] === '-o') {
  ${mode === "exit" ? "process.stdout.write('partial compile output'); process.stderr.write('fixture compile refused'); process.exitCode = 9;" : "process.stdout.write('x'.repeat(5 * 1024 * 1024));"}
} else { console.error('unmodeled command', args); process.exitCode = 97; }
`,
        { mode: 0o700 },
      );
      try {
        let terminalFailure;
        await assert.rejects(
          withCommands((run) =>
            run(
              process.execPath,
              [
                script,
                "--aapt2",
                binary,
                "--apktool",
                binary,
                "--framework",
                framework,
                "--output",
                output,
              ],
              { maxBytes: 1024 * 1024 },
            ),
          ),
          (error) => {
            assert.equal(error.reason, "process");
            assert.equal(error.snapshot.exitCode, 1);
            terminalFailure = terminalReceipt(error.snapshot.stderr.text);
            return true;
          },
        );
        const receipt = JSON.parse(
          await readFile(join(output, "receipt.json"), "utf8"),
        );
        assert.equal(receipt.outcome, "failed");
        assert.equal(receipt.commands.length, 3);
        assert.equal(receipt.commands[0].outcome, "completed");
        assert.equal(
          receipt.commands[0].stdout,
          mode === "exit" ? "" : "fixture AAPT2\n",
        );
        assert.equal(receipt.version, mode === "exit" ? "2.19-fixture" : null);
        assert.deepEqual(
          receipt.version_observations,
          mode === "exit"
            ? [{ channel: "stderr", version: "2.19-fixture" }]
            : [],
        );
        assert.equal(
          receipt.commands[1].stdout,
          mode === "exit" ? "2.7.0-dirty\n" : "3.0.3\n",
        );
        assert.equal(receipt.apktool_build_family, mode === "exit" ? 2 : 3);
        assert.equal(terminalFailure.outcome, "failed");
        assert.equal(
          terminalFailure.receipt_path,
          join(output, "receipt.json"),
        );
        assert.equal(terminalFailure.receipt_published, true);
        assert.equal(terminalFailure.failure.reason, receipt.failure.reason);
        assert.equal("stdout" in terminalFailure.failure.snapshot, false);
        if (mode === "exit")
          assert.equal(terminalFailure.failure.snapshot.exitCode, 9);
        const failed = receipt.commands[2];
        assert.equal(failed.binary, binary);
        assert.equal(failed.arguments[0], "compile");
        assert.equal(failed.outcome, "failed");
        for (const record of [failed.error, receipt.failure]) {
          assert.equal(
            record.reason,
            mode === "exit" ? "process" : "output-limit",
          );
          assert(
            record.snapshot,
            "Owner-captured command diagnostics must survive the receipt",
          );
          assert.equal(record.cleanup_failure, null);
          assert.deepEqual(record.resources, []);
          assert.equal(record.collection_failure, false);
          if (mode === "exit") {
            assert.equal(record.snapshot.exitCode, 9);
            assert.equal(record.snapshot.signal, null);
            assert.equal(record.snapshot.stdout.text, "partial compile output");
            assert.equal(
              record.snapshot.stderr.text,
              "fixture compile refused",
            );
            assert.equal(
              record.snapshot.stderr.bytes,
              Buffer.byteLength("fixture compile refused"),
            );
          } else {
            assert.equal(record.snapshot.diagnosticTruncated, true);
            assert(record.snapshot.stdout.bytes > 0);
            assert(
              record.snapshot.stdout.bytes + record.snapshot.stderr.bytes <=
                4 * 1024 * 1024,
            );
            assert(
              record.snapshot.stdout.observedBytes >
                record.snapshot.stdout.bytes,
            );
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
test(
  "reports primary and receipt-publication failures without expanded diagnostics",
  {
    skip:
      process.platform === "win32"
        ? "The producer fixture uses a POSIX shebang"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-aapt2-publication-"));
    const binary = join(root, "producer");
    const framework = join(root, "framework.jar");
    const output = join(root, "result");
    await writeFile(
      framework,
      "fixture: publication fails after a producer refusal",
    );
    await writeFile(
      binary,
      `#!${process.execPath}
import {mkdirSync} from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'version') console.error('Android Asset Packaging Tool (aapt) 2.19-fixture');
else if (args[0] === '--version') console.log('3.0.3');
else if (args[0] === 'compile') {
  mkdirSync(${JSON.stringify(join(output, "receipt.json"))});
  console.error('controlled compile refusal'); process.exitCode = 9;
} else process.exitCode = 97;
`,
      { mode: 0o700 },
    );
    try {
      await assert.rejects(
        withCommands((run) =>
          run(process.execPath, [
            script,
            "--aapt2",
            binary,
            "--apktool",
            binary,
            "--framework",
            framework,
            "--output",
            output,
          ]),
        ),
        (error) => {
          assert.equal(error.reason, "process");
          assert.equal(error.snapshot.exitCode, 1);
          const failure = terminalReceipt(error.snapshot.stderr.text);
          assert.equal(failure.receipt_published, false);
          assert.equal(failure.receipt_path, join(output, "receipt.json"));
          assert.equal(failure.failure.name, "AggregateError");
          assert.equal(failure.failure.errors[0].reason, "process");
          assert.equal(failure.failure.errors[0].snapshot.exitCode, 9);
          assert.equal("stdout" in failure.failure.errors[0].snapshot, false);
          assert.equal(failure.failure.errors[1].code, "EISDIR");
          assert.match(failure.failure.cause.message, /exited with code 9/u);
          assert.doesNotMatch(
            error.snapshot.stderr.text,
            /controlled compile refusal/u,
          );
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "refuses unknown or unsupported Apktool build families before compiling",
  {
    skip:
      process.platform === "win32"
        ? "The probe fixture uses a POSIX shebang"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-aapt2-version-"));
    const binary = join(root, "producer");
    const framework = join(root, "framework.jar");
    await writeFile(
      framework,
      "fixture: version admission precedes compilation",
    );
    try {
      for (const [index, version] of [
        "fixture Apktool",
        "2.6.1",
        "4.0.0",
      ].entries()) {
        await writeFile(
          binary,
          `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'version') console.error('Android Asset Packaging Tool (aapt) 2.19-fixture');
else if (args[0] === '--version') console.log(${JSON.stringify(version)});
else { console.error('unexpected compilation'); process.exitCode = 97; }
`,
          { mode: 0o700 },
        );
        const output = join(root, `result-${index}`);
        await assert.rejects(
          withCommands((run) =>
            run(process.execPath, [
              script,
              "--aapt2",
              binary,
              "--apktool",
              binary,
              "--framework",
              framework,
              "--output",
              output,
            ]),
          ),
        );
        const receipt = JSON.parse(
          await readFile(join(output, "receipt.json"), "utf8"),
        );
        assert.equal(receipt.outcome, "failed");
        assert.equal(receipt.apktool_build_family, null);
        assert.equal(receipt.commands.length, 2);
        assert.match(
          receipt.failure.message,
          /no build protocol was selected/u,
        );
        assert.equal(
          receipt.apktool_identity.version ??
            receipt.apktool_identity.reportedVersion,
          version,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
const framework = process.env.REA_AAPT2_PROBE_FRAMEWORK;
const aapt2 = process.env.REA_AAPT2_PROBE_COMMAND;
const apktool = process.env.REA_APKTOOL_COMMAND;
test(
  "real AAPT2 inspection, compile/link and Apktool rebuild preserve input identity",
  {
    skip:
      framework === undefined || aapt2 === undefined || apktool === undefined
        ? "Set REA_AAPT2_PROBE_FRAMEWORK, REA_AAPT2_PROBE_COMMAND and REA_APKTOOL_COMMAND for the real lane"
        : false,
    timeout: 300_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-aapt2-real-"));
    try {
      const output = join(root, "result");
      const result = await withCommands((run) =>
        run(
          process.execPath,
          [
            script,
            "--aapt2",
            aapt2,
            "--apktool",
            apktool,
            "--framework",
            framework,
            "--output",
            output,
          ],
          { timeoutMs: 240_000 },
        ),
      );
      assert.match(result.stdout, /prototype:.*passed/u);
      const receipt = JSON.parse(
        await readFile(join(output, "receipt.json"), "utf8"),
      );
      assert.equal(receipt.existing_decode_cli_mcp_parity, true);
      if (process.platform !== "win32") {
        assert.equal(receipt.verifier_run.process_lineage.status, "verified");
        assert.deepEqual(receipt.verifier_run.process_lineage.descendants, []);
      }
      assert.equal(receipt.malformed_resource_refused, true);
      assert.equal(receipt.missing_framework_refused, true);
      assert.equal(receipt.outcome, "completed");
      const build = receipt.commands.find(
        (command) => command.arguments[0] === "b",
      );
      assert.equal(
        build.arguments.includes("--use-aapt2"),
        receipt.apktool_build_family === 2,
      );
      assert.equal(
        build.arguments[build.arguments.indexOf("--aapt") + 1],
        resolve(aapt2),
      );
      assert.match(receipt.rebuilt.sha256, /^[a-f0-9]{64}$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

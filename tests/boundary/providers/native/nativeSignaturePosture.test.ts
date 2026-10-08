import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { stapledTicket } from "../../../../src/native/NativeSignaturePosture.js";
import { AnalysisCancelledError } from "../../../../src/domain/analysisErrorCore.js";
import { ok } from "../../../../src/domain/result.js";
import { inspectSignatureSchema } from "../../../../src/domain/native/nativeInspection.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { notarizationTicketFixture } from "../../../fixtures/notarizationTicket.js";
import {
  NativeFixtureRunner as FixtureRunner,
  nativeMachoTarget as unboundMachoTarget,
} from "../../../fixtures/nativeCommands.js";

const machoTarget = (path: string, app?: string) => ({
  ...unboundMachoTarget(path, app),
  sha256: createHash("sha256").update("fixture").digest("hex"),
});

const TAMPERED_STDERR =
  "--prepared:/Applications/Fixture.app/Contents/XPCServices/B.xpc\n--validated:/Applications/Fixture.app/Contents/XPCServices/B.xpc\n--validated:/Applications/Fixture.app/Contents/PlugIns/A.appex\n/Applications/Fixture.app: a sealed resource is missing or invalid\nfile modified: /Applications/Fixture.app/Contents/Resources/en.lproj/Main.nib\n";

/** Fail only strict verification, as a tampered bundle does. */
class TamperedRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || arguments_[0] !== "--verify") return result;
    const stderr = TAMPERED_STDERR.replaceAll(
      "/Applications/Fixture.app",
      arguments_.at(-1) ?? "",
    );
    return ok({
      ...result.value,
      stdout: "",
      stderr,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
      exitCode: 1,
    });
  }
}

const fixtureApp = async (ticket: string | Uint8Array | undefined) => {
  const directory = await createTestTempDirectory("rea-signature-posture-");
  const app = join(directory, "Fixture.app");
  const executable = join(app, "Contents/MacOS/Fixture");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(executable, "fixture");
  if (ticket !== undefined)
    await writeFile(join(app, "Contents/CodeResources"), ticket);
  return { app, executable };
};

describe("native signature posture", () => {
  it("verifies the opened bundle and reports a stapled ticket", async () => {
    const ticket = notarizationTicketFixture();
    const { app, executable } = await fixtureApp(ticket);
    const signature = await new NativeMacOSProvider(
      new FixtureRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});

    expect(signature.ok).toBe(true);
    if (!signature.ok) return;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.code_directory).toMatchObject({
      version: "20500",
      flags: { value: 0x10000, names: ["runtime"] },
      code_slots: 10,
      special_slots: 7,
    });
    expect(result.verification).toMatchObject({
      path: app,
      status: "valid",
      exit_code: 0,
    });
    expect(result.stapled_ticket).toEqual({
      status: "present",
      path: "Contents/CodeResources",
      sha256: createHash("sha256").update(ticket).digest("hex"),
      size: ticket.length,
      reason: null,
    });
    expect(
      Object.fromEntries(
        result.security_facets.map(({ facet, state }) => [facet, state]),
      ),
    ).toEqual({
      "library-validation": "enforced",
      "dyld-environment-variables": "ignored",
      "debugger-attach": "blocked",
      "executable-memory": "restricted",
      "app-sandbox": "sandboxed",
    });
    expect(result.provenance.map(({ command }) => command[1])).toContain(
      "--verify",
    );
  });

  it("keeps a failed strict verification as an observation", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new TamperedRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});

    expect(signature.ok).toBe(true);
    if (!signature.ok) return;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.verification).toMatchObject({
      path: app,
      status: "invalid",
      exit_code: 1,
      diagnostics: [
        `${app}: a sealed resource is missing or invalid`,
        `file modified: ${app}/Contents/Resources/en.lproj/Main.nib`,
      ],
      validated_nested_code: [
        `${app}/Contents/PlugIns/A.appex`,
        `${app}/Contents/XPCServices/B.xpc`,
      ],
    });
    expect(result.stapled_ticket.status).toBe("absent");
  });

  it("does not look for a stapled ticket beside a bare Mach-O", async () => {
    const directory = await createTestTempDirectory("rea-signature-bare-");
    const executable = join(directory, "tool");
    await writeFile(executable, "fixture");
    const signature = await new NativeMacOSProvider(
      new FixtureRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable))
      .execute("inspect_signature", {});
    expect(signature.ok && signature.value.result).toMatchObject({
      verification: { path: executable },
      stapled_ticket: { status: "not-applicable" },
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps inspecting when the stapled ticket cannot be read",
    async () => {
      const { app, executable } = await fixtureApp("ticket");
      const ticket = join(app, "Contents/CodeResources");
      await chmod(ticket, 0o000);
      try {
        const signature = await new NativeMacOSProvider(
          new FixtureRunner(),
          "darwin",
        )
          .createClient(machoTarget(executable, app))
          .execute("inspect_signature", {});
        expect(signature.ok && signature.value.result).toMatchObject({
          stapled_ticket: {
            status: "unreadable",
            path: "Contents/CodeResources",
            sha256: null,
            reason: "EACCES",
          },
          verification: { status: "valid" },
        });
      } finally {
        await chmod(ticket, 0o644);
      }
    },
  );

  it("reports unsigned nested code inside a signed bundle as invalid", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new UnsignedNestedRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    expect(signature.ok && signature.value.result).toMatchObject({
      signed: true,
      verification: { status: "invalid", exit_code: 1 },
    });
  });
});

describe("native signature posture boundaries", () => {
  it("verifies the inner bundle for iOS-on-Mac wrappers", async () => {
    const directory = await createTestTempDirectory("rea-signature-wrapper-");
    const outer = join(directory, "WrapperApp.app");
    const inner = join(outer, "Wrapper", "Inner.app");
    const executable = join(inner, "Contents/MacOS/Tool");
    await mkdir(join(inner, "Contents/MacOS"), { recursive: true });
    await writeFile(executable, "fixture");
    const target = {
      ...machoTarget(executable),
      sourcePath: outer,
      bundleInfoPlist: join(inner, "Contents/Info.plist"),
    };
    const signature = await new NativeMacOSProvider(
      new FixtureRunner(),
      "darwin",
    )
      .createClient(target)
      .execute("inspect_signature", {});
    expect(signature.ok && signature.value.result).toMatchObject({
      verification: { path: inner },
    });
  });

  it("treats a regular file named .app as a bare Mach-O", async () => {
    const directory = await createTestTempDirectory("rea-signature-file-");
    const executable = join(directory, "Tool.app");
    await writeFile(executable, "fixture");
    const signature = await new NativeMacOSProvider(
      new FixtureRunner(),
      "darwin",
    )
      .createClient({ ...machoTarget(executable), sourcePath: executable })
      .execute("inspect_signature", {});
    expect(signature.ok && signature.value.result).toMatchObject({
      verification: { path: executable },
      stapled_ticket: { status: "not-applicable" },
    });
  });

  it("applies platform policy only after the signature satisfies anchor apple", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const facets = async (anchorExit: number) => {
      const signature = await new NativeMacOSProvider(
        new PlatformRunner(anchorExit),
        "darwin",
      )
        .createClient(machoTarget(executable, app))
        .execute("inspect_signature", {});
      if (!signature.ok) throw signature.error;
      const result = inspectSignatureSchema.parse(signature.value.result);
      expect(result.provenance.map(({ command }) => command.at(-2))).toContain(
        "-R=anchor apple",
      );
      if (anchorExit === 0)
        expect(
          result.limitations.some((line) =>
            line.startsWith("Apple-origin check failed"),
          ),
        ).toBe(false);
      else
        expect(result.limitations).toContain(
          "Apple-origin check failed: code failed to satisfy specified code requirement(s)",
        );
      return Object.fromEntries(
        result.security_facets.map(({ facet, state }) => [facet, state]),
      );
    };
    expect(await facets(0)).toMatchObject({
      "library-validation": "enforced",
      "dyld-environment-variables": "ignored",
      "debugger-attach": "blocked",
    });
    expect(await facets(3)).toMatchObject({
      "library-validation": "unknown",
      "dyld-environment-variables": "unknown",
      "debugger-attach": "unknown",
    });
  });

  it("flags reported nested code that does not exist as a split path", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new NewlinePathRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    // The line projection splits the name; the fragment is flagged.
    expect(result.verification?.validated_nested_code).toEqual([
      `${app}/Contents/Helpers/odd`,
    ]);
    expect(result.limitations).toContainEqual(
      expect.stringContaining(
        `validated nested code at ${JSON.stringify(`${app}/Contents/Helpers/odd`)}, which does not exist`,
      ),
    );
  });

  it("reports cancellation while hashing the stapled ticket", async () => {
    const { app, executable } = await fixtureApp("ticket");
    const controller = new AbortController();
    const signature = await new NativeMacOSProvider(
      new AbortAfterVerifyRunner(controller),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {}, { signal: controller.signal });
    expect(signature.ok).toBe(false);
    if (signature.ok) return;
    expect(signature.error).toBeInstanceOf(AnalysisCancelledError);
  });
});

describe("native signature posture slice-aware cases", () => {
  it("keeps main-executable facets when only nested code fails", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new NestedOnlyFailureRunner(app),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.verification?.status).toBe("invalid");
    expect(
      result.security_facets.find(({ facet }) => facet === "library-validation")
        ?.state,
    ).toBe("enforced");
  });

  it("probes every slice of a universal binary before declaring it signed", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new UniversalMixedRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    // Aggregate display calls report the signed native slice; the unsigned
    // x86_64 slice is found only per-architecture.
    expect(result.verification?.status).toBe("valid");
    expect(
      result.security_facets.find(
        ({ facet }) => facet === "library-validation",
      ),
    ).toMatchObject({
      state: "unknown",
      evidence: ["architecture slices differ in signing state"],
    });
    expect(result.limitations).toContainEqual(
      expect.stringContaining("Unsigned Mach-O slices: x86_64."),
    );
  });

  it("preserves a trailing carriage return in reported nested paths", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new CarriageReturnPathRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    // The CR is a valid pathname byte, not a line delimiter: it is kept and
    // the nonexistent path is flagged rather than silently normalized.
    expect(result.verification?.validated_nested_code).toEqual([
      `${app}/Contents/Helpers/cr\r`,
    ]);
    expect(result.limitations).toContainEqual(
      expect.stringContaining("which does not exist"),
    );
  });

  it("marks facets unknown when signed slices differ in posture", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new UniversalPostureDiffRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    // Every slice verifies, but their CodeDirectory flags disagree.
    expect(result.verification?.status).toBe("valid");
    expect(
      result.security_facets.find(
        ({ facet }) => facet === "library-validation",
      ),
    ).toMatchObject({
      state: "unknown",
      evidence: ["architecture slices differ in signing state"],
    });
    expect(result.limitations).toContainEqual(
      expect.stringContaining("differ in CodeDirectory flags or entitlements"),
    );
  });

  it("reports verification I/O failures as unknown, not invalid", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new PermissionDeniedRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.verification?.status).toBe("unknown");
    expect(result.limitations).toContainEqual(
      expect.stringContaining("not a proven broken signature"),
    );
  });
});

describe("signature architecture coverage", () => {
  it("does not let uncertain display probes hide definitive verification failure", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new DefiniteInvalidWithUncertainSlicesRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.signed).toBe(true);
    expect(result.verification?.status).toBe("invalid");
    expect(result.limitations).toContainEqual(
      expect.stringContaining("could not be classified"),
    );
  });
  it("does not turn inconclusive slice probes into an unsigned claim", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new InconclusiveSlicesRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.signed).toBe(true);
    expect(result.verification?.status).toBe("unknown");
    expect(
      result.security_facets.every(({ state }) => state === "unknown"),
    ).toBe(true);
    expect(result.limitations).toContainEqual(
      expect.stringContaining("could not be classified"),
    );
  });

  it("does not report arbitrary ticket-location bytes as a stapled ticket", async () => {
    const bytes = "stapled ticket bytes";
    const { app, executable } = await fixtureApp(bytes);
    const signature = await new NativeMacOSProvider(
      new FixtureRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.stapled_ticket).toMatchObject({
      status: "unreadable",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      reason: "Not a recognized s8ch notarization ticket container",
    });
  });
  it("probes a valid x86_64h subtype rather than dropping it", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new UniversalMixedRunner("x86_64h"),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.limitations).toContain("Unsigned Mach-O slices: x86_64h.");
    expect(
      result.security_facets.every(({ state }) => state === "unknown"),
    ).toBe(true);
  });

  it("retains per-slice entitlement captures used to compare posture", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new UniversalPostureDiffRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    const commands = result.provenance.filter(
      ({ command }) =>
        command.includes("-a") && command.includes("--entitlements"),
    );
    expect(commands).toHaveLength(2);
    expect(result.entitlements).toEqual({
      "com.apple.security.app-sandbox": true,
    });
  });
});

describe("signature target version binding", () => {
  it("reports a regular ticket replaced by a directory as changed", async () => {
    const { app } = await fixtureApp(notarizationTicketFixture());
    const ticket = await stapledTicket(
      { sourcePath: app, bundleInfoPlist: join(app, "Contents/Info.plist") },
      undefined,
      async (path, phase) => {
        const metadata = await lstat(path);
        if (phase === "before") {
          await rm(path);
          await mkdir(path);
        }
        return metadata;
      },
    );
    expect(ticket).toMatchObject({
      status: "unreadable",
      path: "Contents/CodeResources",
      reason: "changed",
      sha256: null,
    });
  });

  it.each(["EACCES", "EPERM", "EIO"])(
    "preserves final ticket-path failure %s instead of inventing mutation",
    async (code) => {
      const { app } = await fixtureApp(notarizationTicketFixture());
      const ticket = await stapledTicket(
        { sourcePath: app, bundleInfoPlist: join(app, "Contents/Info.plist") },
        undefined,
        async (path, phase) => {
          if (phase === "after")
            throw Object.assign(new Error("host lookup failed"), { code });
          return lstat(path);
        },
      );
      expect(ticket).toMatchObject({
        status: "unreadable",
        reason: code,
        sha256: null,
      });
    },
  );
  it("downgrades facets when the executable changes between captures", async () => {
    const { app, executable } = await fixtureApp(undefined);
    const signature = await new NativeMacOSProvider(
      new ReplacingExecutableRunner(),
      "darwin",
    )
      .createClient(machoTarget(executable, app))
      .execute("inspect_signature", {});
    if (!signature.ok) throw signature.error;
    const result = inspectSignatureSchema.parse(signature.value.result);
    expect(result.verification?.status).toBe("valid");
    expect(
      result.security_facets.every(({ state }) => state === "unknown"),
    ).toBe(true);
    expect(result.limitations).toContain(
      `Signature target changed during inspection: ${executable}`,
    );
    expect(result.security_facets[0]?.evidence).toContain(
      "target version not bound",
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports denied nested-path completeness checks",
    async () => {
      const { app, executable } = await fixtureApp(undefined);
      const helpers = join(app, "Contents/Helpers");
      await mkdir(helpers);
      await chmod(helpers, 0);
      try {
        const signature = await new NativeMacOSProvider(
          new NewlinePathRunner(),
          "darwin",
        )
          .createClient(machoTarget(executable, app))
          .execute("inspect_signature", {});
        if (!signature.ok) throw signature.error;
        const result = inspectSignatureSchema.parse(signature.value.result);
        expect(result.limitations).toContainEqual(
          expect.stringContaining("Could not confirm completeness"),
        );
        expect(result.limitations).toContainEqual(
          expect.stringContaining("permission denied (EACCES)"),
        );
      } finally {
        await chmod(helpers, 0o755);
      }
    },
  );
});

/** Mutate only the fixture after its initial display has been observed. */
class ReplacingExecutableRunner extends FixtureRunner {
  #changed = false;
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (
      !this.#changed &&
      tool === "codesign" &&
      arguments_.includes("--verbose=4")
    ) {
      const path = arguments_.at(-1);
      if (path !== undefined)
        await writeFile(path, "replacement executable bytes");
      this.#changed = true;
    }
    return result;
  }
}

/** A signed bundle whose nested helper is unsigned. */
class UnsignedNestedRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || arguments_[0] !== "--verify") return result;
    const stderr =
      "/Applications/Fixture.app/Contents/Helpers/tool: code object is not signed at all\nIn subcomponent: /Applications/Fixture.app/Contents/Helpers/tool\n";
    return ok({
      ...result.value,
      stdout: "",
      stderr,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
      exitCode: 1,
    });
  }
}

/** A platform binary whose `anchor apple` requirement check exits as given. */
class PlatformRunner extends FixtureRunner {
  constructor(private readonly anchorExit: number) {
    super();
  }

  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || tool !== "codesign") return result;
    if (arguments_.includes("-R=anchor apple")) {
      const target = arguments_.at(-1) ?? "";
      const stderr =
        this.anchorExit === 0
          ? ""
          : `${target}: code failed to satisfy specified code requirement(s)\n`;
      return ok({
        ...result.value,
        exitCode: this.anchorExit,
        stderr,
        stderrBytes: Buffer.byteLength(stderr),
      });
    }
    if (!arguments_.includes("--verbose=4")) return result;
    const stderr = `${result.value.stderr}Platform identifier=26\n`;
    return ok({
      ...result.value,
      stderr,
      stderrBytes: Buffer.byteLength(stderr),
    });
  }
}

/** A nested helper whose file name contains a newline. */
class NewlinePathRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || arguments_[0] !== "--verify") return result;
    const bundle = arguments_.at(-1) ?? "";
    const stderr = `--validated:${bundle}/Contents/Helpers/odd\nname.app\n${bundle}: valid on disk\n`;
    return ok({
      ...result.value,
      stdout: "",
      stderr,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
    });
  }
}

/** Bundle verification fails on nested code while the main executable passes. */
class NestedOnlyFailureRunner extends FixtureRunner {
  constructor(private readonly bundle: string) {
    super();
  }

  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || arguments_[0] !== "--verify") return result;
    if (arguments_.at(-1) !== this.bundle) return result;
    const stderr = `${this.bundle}: a sealed resource is missing or invalid\nfile modified: ${this.bundle}/Contents/XPCServices/Svc.xpc\n`;
    return ok({
      ...result.value,
      stdout: "",
      stderr,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
      exitCode: 1,
    });
  }
}

/**
 * A universal binary whose aggregate display calls report the signed native
 * slice while the x86_64 slice is unsigned.
 */
class UniversalMixedRunner extends FixtureRunner {
  constructor(private readonly foreignArchitecture = "x86_64") {
    super();
  }
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || tool !== "codesign") return result;
    const architectureIndex = arguments_.indexOf("-a");
    if (architectureIndex >= 0) {
      if (arguments_[architectureIndex + 1] !== this.foreignArchitecture)
        return result;
      const stderr = `${arguments_.at(-1)}: code object is not signed at all\n`;
      return ok({
        ...result.value,
        stdout: "",
        stderr,
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr),
        exitCode: 1,
      });
    }
    if (!arguments_.includes("--verbose=4")) return result;
    const stderr = result.value.stderr.replace(
      /^Format=.*$/mu,
      `Format=Mach-O universal (${this.foreignArchitecture} arm64)`,
    );
    return ok({
      ...result.value,
      stderr,
      stderrBytes: Buffer.byteLength(stderr),
    });
  }
}

/** Aggregate display succeeds, but per-architecture probes and verification fail operationally. */
class InconclusiveSlicesRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || tool !== "codesign") return result;
    if (!arguments_.includes("-a") && arguments_[0] !== "--verify")
      return result;
    const stderr = "I/O error reading signing data\n";
    return ok({
      ...result.value,
      stdout: "",
      stderr,
      exitCode: 1,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
    });
  }
}

/** Slice display uncertainty and an independently established invalid signature. */
class DefiniteInvalidWithUncertainSlicesRunner extends InconclusiveSlicesRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || arguments_[0] !== "--verify") return result;
    const stderr = `${arguments_.at(-1)}: invalid signature\n`;
    return ok({
      ...result.value,
      stderr,
      stderrBytes: Buffer.byteLength(stderr),
    });
  }
}

/** A nested helper whose file name ends in a carriage return. */
class CarriageReturnPathRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || arguments_[0] !== "--verify") return result;
    const bundle = arguments_.at(-1) ?? "";
    const stderr = `--validated:${bundle}/Contents/Helpers/cr\r\n${bundle}: valid on disk\n`;
    return ok({
      ...result.value,
      stdout: "",
      stderr,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
    });
  }
}

/**
 * A universal binary whose slices all verify but carry different
 * CodeDirectory flags (hardened arm64, plain x86_64).
 */
class UniversalPostureDiffRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || tool !== "codesign") return result;
    if (arguments_.includes("--entitlements")) return result;
    const architectureIndex = arguments_.indexOf("-a");
    const architecture =
      architectureIndex < 0 ? null : arguments_[architectureIndex + 1];
    let stderr = result.value.stderr;
    if (architecture === null)
      stderr = stderr.replace(
        /^Format=.*$/mu,
        "Format=Mach-O universal (x86_64 arm64)",
      );
    else if (architecture === "x86_64")
      stderr = stderr.replace(
        /flags=0x[0-9a-f]+\([^)]*\)/u,
        "flags=0x2(adhoc)",
      );
    return ok({
      ...result.value,
      stdout: "",
      stderr,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
    });
  }
}

/** Verification fails because nested code cannot be read. */
class PermissionDeniedRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || arguments_[0] !== "--verify") return result;
    const stderr = `${arguments_.at(-1)}: permission denied while reading nested code\n`;
    return ok({
      ...result.value,
      stdout: "",
      stderr,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
      exitCode: 1,
    });
  }
}

/** Cancel the request once local verification has finished. */
class AbortAfterVerifyRunner extends FixtureRunner {
  constructor(private readonly controller: AbortController) {
    super();
  }

  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (arguments_[0] === "--verify") this.controller.abort();
    return result;
  }
}

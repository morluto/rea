import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { spawn } from "@lydell/node-pty";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const decisionMarker = "REA_SETUP_DECISION:";

const actions = [
  {
    id: "configure_client:codex",
    kind: "configure_client",
    label: "Codex",
    target: "/isolated/.codex/config.toml",
    detail: "Add the REA MCP registration for Codex.",
    external: false,
    operation: "create",
  },
  {
    id: "install_skill",
    kind: "install_skill",
    label: "REA reverse-engineering skill",
    target: "/isolated/.agents/skills/reverse-engineering/SKILL.md",
    detail: "Install the bundled reverse-engineering skill.",
    external: false,
    operation: "install",
  },
  {
    id: "install_hopper",
    kind: "install_hopper",
    label: "Hopper deep-analysis provider",
    target: "/isolated/Applications/Hopper Disassembler.app",
    detail: "Install the verified Hopper package.",
    external: true,
    operation: "install",
  },
] as const;

describe("interactive setup journey", () => {
  it("leads with value, detected targets, modality labels, and durable key help", async () => {
    const result = await runJourney([step("Choose a setup", "\u0003")]);

    expect(result.output).toContain(
      "Understand local apps and binaries from your coding agent.",
    );
    expect(result.output).toContain(
      "Trace how a feature works with local evidence.",
    );
    expect(result.output).toContain("Detected Codex");
    expect(result.output).toContain("Codex · MCP · create");
    expect(result.output).toContain("Hopper deep-analysis provider (provider)");
    expect(result.output).toContain("REA reverse-engineering skill (skill)");
    expect(result.output).toContain(
      "Keys: ↑/↓ navigate · Space toggle · Enter confirm · Ctrl-C cancel",
    );
    expect(result.decision.approved).toBe(false);
  });

  it("offers recommended, custom, and no-thanks intent before choosing targets", async () => {
    const result = await runJourney([
      step("Choose a setup", "\u001b[B\u001b[B\r"),
    ]);

    expect(result.output).toContain("Set up all available capabilities");
    expect(result.output).toContain("recommended · 3 changes");
    expect(result.output).toContain("Customize setup");
    expect(result.output).toContain("No thanks");
    expect(result.output).not.toContain("Ready to review");
    expect(result.decision).toMatchObject({ approved: false });
  });

  it("lets custom mode reach the modality-labelled target picker and cancel safely", async () => {
    const result = await runJourney([
      step("Choose a setup", "\u001b[B\r"),
      step("Choose what REA should configure", "\u0003"),
    ]);

    expect(result.output).toContain("Choose what REA should configure");
    expect(result.output).toContain("Codex (MCP)");
    expect(result.output).toContain("Hopper deep-analysis provider (provider)");
    expect(result.output).toContain("Setup cancelled. No changes were made.");
    expect(result.decision.approved).toBe(false);
  });

  it("keeps the recommended path subject to a default-No exact preflight", async () => {
    const result = await runJourney([
      step("Choose a setup", "\r"),
      step("Apply these 3 changes?", "\r"),
    ]);

    expect(result.output).toContain("Ready to review");
    expect(result.output).toContain("CREATE  Codex");
    expect(result.output).toContain("/isolated/.codex/config.toml");
    expect(result.output).toContain("No, cancel");
    expect(result.output).toContain("Setup cancelled. No changes were made.");
    expect(result.decision).toEqual({
      approved: false,
      selectedActionIds: actions.map(({ id }) => id),
    });
  });

  it("frames completion around the capabilities that are now ready", async () => {
    const { stderr } = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { renderInteractiveSetupResult } from "./dist/cliSetup.js";',
          "renderInteractiveSetupResult({",
          '  status: "ready",',
          "  plannedActions: [],",
          "  appliedActions: [],",
          '  clients: { codex: { status: "configured" } },',
          "  doctor: {",
          "    healthy: true,",
          '    hopperPath: "/Applications/Hopper",',
          "    checks: [],",
          '    providerInspections: [{ id: "ghidra", available: true }],',
          '    identity: { skill: { state: "aligned" }, registrations: [{ client: "codex", state: "aligned" }] },',
          "  },",
          "});",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, NO_COLOR: "1" },
      },
    );

    expect(stderr).toContain("What you can do now");
    expect(stderr).toContain("Deep analysis: Hopper and Ghidra");
    expect(stderr).toContain("Agent access: Codex");
    expect(stderr).toContain("Guided reverse-engineering workflows: installed");
    expect(stderr).toContain("CLI: rea analyze /path/to/app");
    expect(stderr).toContain(
      'Try in Codex: "Use REA to explain how a feature works in /path/to/app."',
    );
  });
});

interface JourneyStep {
  readonly prompt: string;
  readonly input: string;
}

interface JourneyResult {
  readonly output: string;
  readonly decision: {
    readonly approved: boolean;
    readonly selectedActionIds: readonly string[];
  };
}

const step = (prompt: string, input: string): JourneyStep => ({
  prompt,
  input,
});

const runJourney = async (
  steps: readonly JourneyStep[],
): Promise<JourneyResult> => {
  const isolatedHome = await mkdtemp(join(tmpdir(), "rea-cli-setup-test-"));
  const script = [
    'import { confirmInteractiveSetup } from "./dist/cliSetup.js";',
    `const actions = ${JSON.stringify(actions)};`,
    "const decision = await confirmInteractiveSetup(actions, false);",
    `process.stdout.write(${JSON.stringify(`\n${decisionMarker}`)} + JSON.stringify(decision) + "\\n");`,
  ].join("\n");

  return new Promise<JourneyResult>((resolvePromise, reject) => {
    let output = "";
    let nextStep = 0;
    let settled = false;
    const terminal = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: isolatedHome,
          NO_COLOR: "1",
          TERM: "xterm-256color",
        },
        name: "xterm-256color",
        cols: 120,
        rows: 40,
      },
    );
    const timeout = setTimeout(() => {
      terminal.kill();
      finish(new Error(`Timed out after output:\n${output}`));
    }, 10_000);

    terminal.onData((data) => {
      output += data;
      const pending = steps[nextStep];
      if (pending !== undefined && output.includes(pending.prompt)) {
        nextStep += 1;
        terminal.write(pending.input);
      }
    });
    terminal.onExit(({ exitCode }) => {
      if (exitCode !== 0) {
        finish(
          new Error(`Setup journey exited ${String(exitCode)}:\n${output}`),
        );
        return;
      }
      if (nextStep !== steps.length) {
        finish(new Error(`Setup journey missed an interaction:\n${output}`));
        return;
      }
      const markerIndex = output.lastIndexOf(decisionMarker);
      if (markerIndex === -1) {
        finish(new Error(`Setup journey returned no decision:\n${output}`));
        return;
      }
      const serialized = output
        .slice(markerIndex + decisionMarker.length)
        .split(/\r?\n/u, 1)[0];
      if (serialized === undefined) {
        finish(
          new Error(`Setup journey returned an empty decision:\n${output}`),
        );
        return;
      }
      try {
        finish(undefined, {
          output,
          decision: JSON.parse(serialized) as JourneyResult["decision"],
        });
      } catch (cause: unknown) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });

    function finish(error?: Error, result?: JourneyResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void rm(isolatedHome, { recursive: true, force: true }).finally(() => {
        if (error !== undefined) reject(error);
        else if (result !== undefined) resolvePromise(result);
        else reject(new Error("Setup journey completed without a result"));
      });
    }
  });
};

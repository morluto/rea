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
  it("leads with value, a compact detected-target summary, and durable key help", async () => {
    const result = await runJourney([
      step("What should REA set up?", "\u0003"),
    ]);

    expect(result.output).toContain(
      "Understand local apps and binaries from your coding agent.",
    );
    expect(result.output).toContain(
      "Trace how a feature works with local evidence.",
    );
    expect(result.output).toContain("Found 1 supported agent");
    expect(result.output).toContain("Codex");
    expect(result.output).toContain("Hopper deep-analysis provider (provider)");
    expect(result.output).toContain("REA reverse-engineering skill (skill)");
    expect(result.output).toContain(
      "Keys: ↑/↓ navigate · Space toggle · Enter confirm · Ctrl-C cancel",
    );
    expect(result.decision.approved).toBe(false);
  });

  it("does not turn available capabilities into selected setup actions", async () => {
    const result = await runJourney([step("What should REA set up?", "\r")]);

    expect(result.output).toContain("Coding-agent access (MCP)");
    expect(result.output).toContain("REA reverse-engineering skill (skill)");
    expect(result.output).toContain("Hopper deep-analysis provider (provider)");
    expect(result.output).not.toContain("Ready to review");
    expect(result.output).toContain("Nothing selected. No changes were made.");
    expect(result.decision).toEqual({
      approved: false,
      selectedActionIds: [],
    });
  });

  it("omits MCP access when no agent integration needs configuration", async () => {
    const result = await runJourney(
      [step("What should REA set up?", "\r")],
      false,
      actions.filter(({ kind }) => kind !== "configure_client"),
    );

    expect(result.output).toContain("No agent integrations need configuration");
    expect(result.output).not.toContain("Coding-agent access (MCP)");
    expect(result.decision.selectedActionIds).toEqual([]);
  });

  it("shows multiple detected agents without preselecting either one", async () => {
    const result = await runJourney(
      [
        step("What should REA set up?", " \r"),
        step("Which agents should use REA?", "\u0003"),
      ],
      false,
      [
        actions[0],
        {
          ...actions[0],
          id: "configure_client:cursor",
          label: "Cursor",
          target: "/isolated/.cursor/mcp.json",
        },
        ...actions.slice(1),
      ],
    );

    expect(result.output).toContain("Codex (detected)");
    expect(result.output).toContain("Cursor (detected)");
    expect(result.decision.approved).toBe(false);
  });

  it("asks for agent targets only after MCP access is selected", async () => {
    const result = await runJourney([
      step("What should REA set up?", " \r"),
      step("Which agents should use REA?", "\u0003"),
    ]);

    expect(result.output).toContain("Codex (detected)");
    expect(result.output).toContain("Setup cancelled. No changes were made.");
    expect(result.decision.approved).toBe(false);
  });

  it("reviews only explicitly selected actions with default-No consent", async () => {
    const result = await runJourney([
      step("What should REA set up?", " \r"),
      step("Which agents should use REA?", " \r"),
      step("Apply this change?", "\r"),
    ]);

    expect(result.output).toContain("Ready to review");
    expect(result.output).toContain("CREATE  Codex");
    expect(result.output).toContain("/isolated/.codex/config.toml");
    expect(result.output).not.toContain(
      "INSTALL  REA reverse-engineering skill",
    );
    expect(result.output).not.toContain(
      "INSTALL  Hopper deep-analysis provider",
    );
    expect(result.output).toContain("No, cancel");
    expect(result.output).toContain("Setup cancelled. No changes were made.");
    expect(result.decision).toEqual({
      approved: false,
      selectedActionIds: ["configure_client:codex"],
    });
  });

  it("can select the shared skill without selecting an agent integration", async () => {
    const result = await runJourney([
      step("What should REA set up?", "\u001b[B \r"),
      step("Apply this change?", "\r"),
    ]);

    expect(result.output).toContain("INSTALL  REA reverse-engineering skill");
    expect(result.output).not.toContain("CREATE  Codex");
    expect(result.output).not.toContain(
      "INSTALL  Hopper deep-analysis provider",
    );
    expect(result.decision).toEqual({
      approved: false,
      selectedActionIds: ["install_skill"],
    });
  });

  it("keeps every accessible capability prompt defaulted to skip", async () => {
    const result = await runJourney(
      [
        step("Set up Coding-agent access (MCP)?", "\r"),
        step("Set up REA reverse-engineering skill (skill)?", "\r"),
        step("Set up Hopper deep-analysis provider (provider)?", "\r"),
      ],
      true,
    );

    expect(result.output).not.toContain("Ready to review");
    expect(result.decision.selectedActionIds).toEqual([]);
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
  accessible = false,
  journeyActions: readonly object[] = actions,
): Promise<JourneyResult> => {
  const isolatedHome = await mkdtemp(join(tmpdir(), "rea-cli-setup-test-"));
  const script = [
    'import { confirmInteractiveSetup } from "./dist/cliSetup.js";',
    `const actions = ${JSON.stringify(journeyActions)};`,
    `const decision = await confirmInteractiveSetup(actions, ${JSON.stringify(accessible)});`,
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

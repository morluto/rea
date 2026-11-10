import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const posix = it.skipIf(process.platform === "win32");
posix.each([
  ["empty", false],
  ["empty body", false],
  ["wrong role", false],
  ["wrong id", false],
  ["missing body", false],
  ["complete", true],
] as const)(
  "requires CommandCode skill proof for %s",
  async (mode, allowed) => {
    const state = await mkdtemp(join(tmpdir(), "rea-commandcode-skill-"));
    try {
      const account = join(state, "account");
      await mkdir(account);
      await writeFile(
        join(account, ".rea-client-verification"),
        "Disposable REA client verification account\n",
      );
      const commands = String.raw`
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_CONTRACTS } from REPLACE_CONTRACTS;

let setup = 0;
export async function createVerifierCommands() {
  return {
    async exec(command, args, options = {}) {
      if (command === "git") return { stdout: "", stderr: "" };
      if (args.includes("--version")) return { stdout: "fake", stderr: "" };
      const account = options.env.USERPROFILE;
      const profile = join(account, ".commandcode");
      const config = join(profile, "mcp.json");
      const skill = join(account, ".agents", "skills", "reverse-engineer-anything");
      if (args.includes("setup") && args.includes("--dry-run")) {
        return { stdout: JSON.stringify({ status: "planned", plannedActions: [{ target: config }, { target: skill }] }), stderr: "" };
      }
      if (args.includes("setup")) {
        if (setup++ === 0) {
          await writeFile(config + ".rea.backup", await readFile(config));
          await mkdir(skill, { recursive: true });
          const frontmatter = "---\nname: reverse-engineer-anything\n---\n";
          const body = 'Complete "authored" instructions\nKeep a \\ literal\n';
          await writeFile(join(skill, "SKILL.md"), process.env.MODE === "empty" ? "" : frontmatter + (process.env.MODE === "empty body" ? "" : body));
          return { stdout: JSON.stringify({ status: "ready" }), stderr: "" };
        }
        return { stdout: JSON.stringify({ appliedActions: [] }), stderr: "" };
      }
      if (args.includes("doctor")) return { stdout: JSON.stringify({ healthy: true }), stderr: "" };
      const tools = [
        { name: "search_tools" },
        { name: "activate_skill", parameters: { properties: { name: { enum: ["reverse-engineer-anything"] } } } },
      ];
      const system = { role: "system", content: TOOL_CONTRACTS.map((t) => "mcp__rea__" + t.name).join(" ") };
      const first = await globalThis.fakeRequest({ body: { messages: [system] }, tools });
      const body = 'Complete "authored" instructions\nKeep a \\ literal';
      const response = {
        role: process.env.MODE === "wrong role" ? "user" : "tool",
        tool_call_id: process.env.MODE === "wrong id" ? "wrong" : first.tool_calls[0].id,
        content: process.env.MODE === "missing body" ? "partial" : body,
      };
      const second = await globalThis.fakeRequest({ body: { messages: [system, response] }, tools });
      await writeFile(process.env.STATE + "/observed.json", JSON.stringify({ first, second }));
      throw Error("intentional stop before client output");
    },
    async close() {},
  };
}
`.replace(
        "REPLACE_CONTRACTS",
        JSON.stringify(
          new URL("../../../dist/contracts/toolContracts.js", import.meta.url)
            .href,
        ),
      );
      await writeFile(join(state, "commands.mjs"), commands);
      await writeFile(
        join(state, "fixture.mjs"),
        "export async function createOpenAiModelFixture({onRequest}){globalThis.fakeRequest=onRequest;return {baseUrl:'http://127.0.0.1:1',async close(){}};}\n",
      );
      await writeFile(
        join(state, "hook.mjs"),
        "import{registerHooks}from'node:module';import{pathToFileURL}from'node:url';registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/verify-commandcode-client.mjs')){let f;if(specifier==='node:os')f='os.mjs';if(specifier==='./lib/verify-commands.mjs')f='commands.mjs';if(specifier==='./verify/clients/model-fixture.mjs')f='fixture.mjs';if(f)return{url:pathToFileURL(process.env.STATE+'/'+f).href,shortCircuit:true};}return next(specifier,context);}});\n",
      );
      await writeFile(
        join(state, "os.mjs"),
        "export * from 'node:os';export function homedir(){return process.env.REA_VERIFY_COMMANDCODE_ACCOUNT_HOME;}\n",
      );
      const script = fileURLToPath(
        new URL(
          "../../../scripts/verify-commandcode-client.mjs",
          import.meta.url,
        ),
      );
      const result = spawnSync(
        process.execPath,
        ["--import", join(state, "hook.mjs"), script],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            STATE: state,
            MODE: mode,
            REA_VERIFY_COMMANDCODE_ACCOUNT_HOME: account,
          },
        },
      );
      expect(result.status).not.toBe(0);
      const observed = await readFile(
        join(state, "observed.json"),
        "utf8",
      ).then(JSON.parse, () => null);
      expect(observed !== null).toBe(allowed);
      if (allowed)
        expect(observed.second.tool_calls[0].function.name).toBe(
          "search_tools",
        );
      expect(result.stderr).toContain(
        allowed
          ? "intentional stop before client output"
          : mode === "empty"
            ? "Installed skill must have authored frontmatter"
            : mode === "empty body"
              ? "Installed skill body must not be empty"
              : "The model must receive the complete activated skill body",
      );
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  },
);

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  ["sibling", false],
  ["parent traversal", false],
  ["owned child", true],
] as const)(
  "checks a %s setup-plan target before writing",
  async (kind, allowed) => {
    const state = await mkdtemp(join(tmpdir(), "rea-claude-plan-"));
    try {
      const commands = join(state, "commands.mjs");
      const fixture = join(state, "fixture.mjs");
      const hook = join(state, "hook.mjs");
      await writeFile(
        commands,
        `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function createVerifierCommands(){return {
 async exec(command,args,options={}){
  if(command==='git')return {stdout:'',stderr:''};
  if(args[0]==='--version')return {stdout:'fake client',stderr:''};
  if(args.includes('setup') && args.includes('--dry-run')){
    const profile=options.env.CLAUDE_CONFIG_DIR; const skill=join(profile,'skills','reverse-engineer-anything');
    const candidate=process.env.KIND==='sibling' ? skill+'-sibling/AGENTS.md' : process.env.KIND==='parent traversal' ? skill+'/../outside/AGENTS.md' : skill+'/AGENTS.md';
    return {stdout:JSON.stringify({status:'planned',plannedActions:[{target:join(profile,'.claude.json')},{target:skill},{target:candidate}]}),stderr:''};
  }
  await writeFile(process.env.STATE+'/setup-advanced','yes'); throw Error('intentional stop before setup mutation');
 }, async close(){} };}`,
      );
      await writeFile(
        fixture,
        `export async function createAnthropicModelFixture(){return {baseUrl:'http://127.0.0.1:1',async close(){}};}`,
      );
      await writeFile(
        hook,
        `import {registerHooks} from 'node:module';import{pathToFileURL}from'node:url';
registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/verify-claude-client.mjs')){let f;if(specifier==='./lib/verify-commands.mjs')f='commands.mjs';if(specifier==='./verify/clients/anthropic-model-fixture.mjs')f='fixture.mjs';if(f)return{url:pathToFileURL(process.env.STATE+'/'+f).href,shortCircuit:true};}return next(specifier,context);}});`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          hook,
          fileURLToPath(
            new URL(
              "../../../scripts/verify-claude-client.mjs",
              import.meta.url,
            ),
          ),
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            STATE: state,
            KIND: kind,
            TMPDIR: state,
            TMP: state,
            TEMP: state,
          },
        },
      );
      expect(result.status).not.toBe(0);
      const advanced = await readFile(
        join(state, "setup-advanced"),
        "utf8",
      ).then(
        () => true,
        () => false,
      );
      expect(advanced).toBe(allowed);
      expect(result.stderr).toContain(
        allowed ? "intentional stop before setup mutation" : "AssertionError",
      );
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  },
);

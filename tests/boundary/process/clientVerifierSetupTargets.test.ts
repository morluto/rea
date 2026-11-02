import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(
  (
    [
      ["gemini", "relative path", false],
      ["gemini", "profile traversal", false],
      ["gemini", "profile root alias", false],
      ["gemini", "skill root alias", false],
      ["gemini", "skill traversal", false],
      ["gemini", "owned child", true],
      ["copilot", "relative path", false],
      ["copilot", "sibling", false],
      ["copilot", "skill traversal", false],
      ["copilot", "owned child", true],
      ["qwen", "relative path", false],
      ["qwen", "profile traversal", false],
      ["qwen", "profile root alias", false],
      ["qwen", "skill root alias", false],
      ["qwen", "skill traversal", false],
      ["qwen", "profile child", true],
      ["qwen", "skill child", true],
    ] as const
  ).filter(([client]) => process.platform !== "win32" || client !== "copilot"),
)(
  "%s checks %s setup-plan targets before writing",
  async (client, kind, allowed) => {
    const state = await mkdtemp(join(tmpdir(), "rea-client-plan-"));
    try {
      const commands = join(state, "commands.mjs");
      const fixture = join(state, "fixture.mjs");
      const hook = join(state, "hook.mjs");
      await writeFile(
        commands,
        `import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
export async function createVerifierCommands(){return {
 async exec(command,args,options={}){
  if(command==='git')return {stdout:'',stderr:''};
  if(args.includes('--version'))return {stdout:'fake client',stderr:''};
  if(args.includes('setup') && args.includes('--dry-run')){
    const client=process.env.CLIENT; const kind=process.env.KIND;
    const profile=client==='gemini'?options.env.GEMINI_CLI_HOME:client==='copilot'?options.env.COPILOT_HOME:options.env.QWEN_HOME;
    const skills=join(client==='gemini'?profile:options.env.HOME,'.agents','skills');
    const skill=join(skills,'reverse-engineer-anything');
    const config=join(profile,client==='gemini'?'.gemini/settings.json':client==='copilot'?'mcp-config.json':'settings.json');
    const candidate=kind==='relative path'?'relative/AGENTS.md':kind==='profile root alias'?profile+'/child/..':kind==='skill root alias'?skills+'/child/..':kind==='profile traversal'?profile+'/../outside/AGENTS.md':kind==='skill traversal'?(client==='copilot'?skill:skills)+'/../outside/AGENTS.md':kind==='sibling'?skill+'-sibling/AGENTS.md':kind==='profile child'?config:join(skill,'SKILL.md');
    const selectedSkill=(kind==='skill traversal'||kind==='skill root alias')&&client==='gemini'?candidate:join(skill,'SKILL.md');
    const actions=client==='qwen'?[{target:candidate}]:[{target:config},{target:client==='copilot'?skill:selectedSkill},{target:candidate}];
    return {stdout:JSON.stringify({status:'planned',plannedActions:actions}),stderr:''};
  }
  await writeFile(process.env.STATE+'/setup-advanced','yes'); throw Error('intentional stop before setup mutation');
 }, async close(){} };}`,
      );
      await writeFile(
        fixture,
        `export async function createOpenAiModelFixture(){return {baseUrl:'http://127.0.0.1:1',async close(){}};}`,
      );
      await writeFile(
        hook,
        `import {registerHooks} from 'node:module';import{pathToFileURL}from'node:url';
registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/verify-'+process.env.CLIENT+'-client.mjs')){let f;if(specifier==='./lib/verify-commands.mjs')f='commands.mjs';if(specifier==='./verify/clients/model-fixture.mjs')f='fixture.mjs';if(f)return{url:pathToFileURL(process.env.STATE+'/'+f).href,shortCircuit:true};}return next(specifier,context);}});`,
      );
      const script = fileURLToPath(
        new URL(
          `../../../scripts/verify-${client}-client.mjs`,
          import.meta.url,
        ),
      );
      const result = spawnSync(process.execPath, ["--import", hook, script], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          STATE: state,
          CLIENT: client,
          KIND: kind,
          TMPDIR: state,
          TMP: state,
          TEMP: state,
        },
      });
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

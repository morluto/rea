import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(
  (
    [
      ["claude", "relative path", false],
      ["claude", "sibling", false],
      ["claude", "parent traversal", false],
      ["claude", "owned child", true],
      ["opencode", "relative path", false],
      ["opencode", "sibling", false],
      ["opencode", "parent traversal", false],
      ["opencode", "owned child", true],
    ] as const
  ).filter(([client]) => process.platform !== "win32" || client !== "opencode"),
)(
  "%s checks a %s setup-plan target before writing",
  async (client, kind, allowed) => {
    const state = await mkdtemp(join(tmpdir(), "rea-claude-plan-"));
    try {
      const commands = join(state, "commands.mjs");
      const fixture = join(state, "fixture.mjs");
      const hook = join(state, "hook.mjs");
      await writeFile(
        commands,
        `import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
export async function createVerifierCommands(){return {
 async exec(command,args,options={}){
  if(command==='git')return {stdout:'',stderr:''};
  if(args[0]==='--version')return {stdout:'fake client',stderr:''};
  if(args.includes('setup') && args.includes('--dry-run')){
    const client=process.env.CLIENT; const profile=client==='claude'?options.env.CLAUDE_CONFIG_DIR:options.env.OPENCODE_CONFIG_DIR; const skill=client==='claude'?join(profile,'skills','reverse-engineer-anything'):join(options.env.USERPROFILE,'.agents','skills','reverse-engineer-anything');
    const candidate=process.env.KIND==='relative path' ? relative(process.cwd(),join(skill,'AGENTS.md')) : process.env.KIND==='sibling' ? skill+'-sibling/AGENTS.md' : process.env.KIND==='parent traversal' ? skill+'/../outside/AGENTS.md' : skill+'/AGENTS.md';
    if (process.env.KIND==='relative path' && (candidate==='' || isAbsolute(candidate))) throw Error('Fixture expected a relative target');
    return {stdout:JSON.stringify({status:'planned',plannedActions:[{target:join(profile,client==='claude'?'.claude.json':'opencode.jsonc')},{target:skill},{target:candidate}]}),stderr:''};
  }
  await writeFile(process.env.STATE+'/setup-advanced','yes'); throw Error('intentional stop before setup mutation');
 }, async close(){} };}`,
      );
      await writeFile(
        fixture,
        `export async function createAnthropicModelFixture(){return {baseUrl:'http://127.0.0.1:1',async close(){}};} export const createOpenAiModelFixture=createAnthropicModelFixture;`,
      );
      await writeFile(
        hook,
        `import {registerHooks} from 'node:module';import{pathToFileURL}from'node:url';
registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/verify-'+process.env.CLIENT+'-client.mjs')){let f;if(specifier==='./lib/verify-commands.mjs')f='commands.mjs';if(specifier==='./verify/clients/anthropic-model-fixture.mjs'||specifier==='./verify/clients/model-fixture.mjs')f='fixture.mjs';if(f)return{url:pathToFileURL(process.env.STATE+'/'+f).href,shortCircuit:true};}return next(specifier,context);}});`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          hook,
          fileURLToPath(
            new URL(
              `../../../scripts/verify-${client}-client.mjs`,
              import.meta.url,
            ),
          ),
        ],
        {
          encoding: "utf8",
          cwd: state,
          timeout: 10_000,
          env: {
            ...process.env,
            STATE: state,
            KIND: kind,
            CLIENT: client,
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

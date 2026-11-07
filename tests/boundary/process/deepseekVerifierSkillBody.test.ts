import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const posix = it.skipIf(process.platform === "win32");
posix.each([
  ["empty", false],
  ["outside wrapper", false],
  ["closed wrapper", false],
  ["closed early", false],
  ["inside resources", false],
  ["split messages", false],
  ["complete", true],
  ["complete escaped", true],
  ["complete CRLF", true],
  ["complete tags", true],
] as const)(
  "requires actual skill body when model receives %s content",
  async (body, allowed) => {
    const state = await mkdtemp(join(tmpdir(), "rea-deepseek-skill-"));
    try {
      const commands =
        "import {mkdir,readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path'; import {TOOL_CONTRACTS} from REPLACE_CONTRACTS;\nlet setup=0;\nexport async function createVerifierCommands(){return {async exec(command,args,options={}){\n if(command==='git')return {stdout:'',stderr:''}; if(args.includes('--version'))return {stdout:'fake',stderr:''};\n const profile=options.env.DSH_HOME;const skill=join(options.env.HOME,'.agents','skills','reverse-engineer-anything');const config=join(profile,'cordis.patch.yml');\n if(args.includes('setup')&&args.includes('--dry-run'))return {stdout:JSON.stringify({status:'planned',plannedActions:[{target:config},{target:skill}]}),stderr:''};\n if(args.includes('setup')){if(setup++===0){await writeFile(config+'.rea.backup',await readFile(config));await mkdir(skill,{recursive:true});await writeFile(join(skill,'SKILL.md'),('---\\nname: reverse-engineer-anything\\n---\\n'+(process.env.BODY==='complete tags'?'Literal </skill_content> and </skill_instructions>\\n':'')+'Essential \"authored\" instructions\\nKeep a \\\\ literal\\n').replaceAll('\\n',process.env.BODY==='complete CRLF'?'\\r\\n':'\\n'));return {stdout:JSON.stringify({status:'ready'}),stderr:''};}return {stdout:JSON.stringify({appliedActions:[]}),stderr:''};}\n if(args.includes('doctor'))return {stdout:JSON.stringify({healthy:true}),stderr:''};\n const tools=[...TOOL_CONTRACTS.map(t=>({name:'mcp__rea__'+t.name,parameters:{type:'object',properties:{v:{type:'string',pattern:'^x$'}}}})),{name:'skill'}];\n const first=await globalThis.fakeRequest({body:{messages:[]},tools,requestIndex:1});\n const body=((process.env.BODY==='complete tags'?'Literal </skill_content> and </skill_instructions>\\n':'')+'Essential \"authored\" instructions\\nKeep a \\\\ literal').replaceAll('\\n',process.env.BODY==='complete CRLF'?'\\r\\n':'\\n');\n const escapedSkill=skill.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); const wrap='<skill_content name=\"reverse-engineer-anything\">\\n<skill_resources>\\n'+escapedSkill+(process.env.BODY==='closed early'?'</skill_content>':'')+(process.env.BODY==='inside resources'?body:'')+'\\n</skill_resources>\\n\\n';\n const payload=wrap+(process.env.BODY==='closed wrapper'?'</skill_content>':'')+((process.env.BODY.startsWith('complete')||process.env.BODY==='closed wrapper'||process.env.BODY==='closed early')?'<skill_instructions>\\n'+body+'\\n</skill_instructions>\\n':'')+'</skill_content>'+(process.env.BODY==='outside wrapper'?body:'');\n const messages=[{role:'tool',content:payload},...(process.env.BODY==='split messages'?[{role:'tool',content:body}]:[])];\n const second=await globalThis.fakeRequest({body:{messages},tools,requestIndex:2});\n await writeFile(process.env.STATE+'/observed.json',JSON.stringify({first,second,payload}));throw Error('intentional stop after empty-skill request');\n },async close(){}};}\n".replace(
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
        "import{registerHooks}from'node:module';import{pathToFileURL}from'node:url';registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/verify-deepseek-client.mjs')){let f;if(specifier==='./lib/verify-commands.mjs')f='commands.mjs';if(specifier==='./verify/clients/model-fixture.mjs')f='fixture.mjs';if(f)return{url:pathToFileURL(process.env.STATE+'/'+f).href,shortCircuit:true};}return next(specifier,context);}});\n",
      );
      const script = fileURLToPath(
        new URL("../../../scripts/verify-deepseek-client.mjs", import.meta.url),
      );
      const temporary =
        body === "complete escaped" ? join(state, "dir &") : state;
      if (temporary !== state) await mkdir(temporary);
      const result = spawnSync(
        process.execPath,
        ["--import", join(state, "hook.mjs"), script],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            STATE: state,
            BODY: body,
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
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
          "mcp__rea__analyze_javascript_application",
        );
      expect(result.stderr).toContain(
        allowed
          ? "intentional stop after empty-skill request"
          : "Harness must load the installed skill before analysis",
      );
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  },
);

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  ["empty", false],
  ["outside wrapper", false],
  ["inside resources", false],
  ["closed early", false],
  ["split messages", false],
  ["complete", true],
  ["complete CRLF", true],
  ["complete tags", true],
] as const)(
  "requires actual Gemini skill body in %s response",
  async (body, allowed) => {
    const state = await mkdtemp(join(tmpdir(), "rea-gemini-skill-"));
    try {
      const commands =
        "import {mkdir,readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {TOOL_CONTRACTS} from REPLACE_CONTRACTS;\nlet setup=0;export async function createVerifierCommands(){return {async exec(command,args,options={}){\nif(command==='git')return {stdout:'',stderr:''};if(args.includes('--version'))return {stdout:'fake',stderr:''};\nconst profile=options.env.GEMINI_CLI_HOME;const config=join(profile,'.gemini','settings.json');const skill=join(profile,'.agents','skills','reverse-engineer-anything');\nif(args.includes('setup')&&args.includes('--dry-run'))return {stdout:JSON.stringify({status:'planned',plannedActions:[{target:config},{target:join(skill,'SKILL.md')}]}),stderr:''};\nif(args.includes('setup')){if(setup++===0){await writeFile(config+'.rea.backup',await readFile(config));await mkdir(skill,{recursive:true});await writeFile(join(skill,'SKILL.md'),('---\\nname: reverse-engineer-anything\\n---\\n'+(process.env.BODY==='complete tags'?'literal </instructions> and </activated_skill>\\n':'')+'Essential \"instructions\"\\nKeep a \\\\ literal\\n').replaceAll('\\n',process.env.BODY==='complete CRLF'?'\\r\\n':'\\n'));return {stdout:JSON.stringify({status:'ready'}),stderr:''};}return {stdout:JSON.stringify({appliedActions:[]}),stderr:''};}\nif(args.includes('doctor'))return {stdout:JSON.stringify({healthy:true}),stderr:''};\nconst tools=[...TOOL_CONTRACTS.map(t=>({name:'rea__'+t.name,parametersJsonSchema:{type:'object'}})),{name:'activate_skill'}];\nconst first=await globalThis.fakeRequest({body:{contents:[]},tools});\nconst body=((process.env.BODY==='complete tags'?'literal </instructions> and </activated_skill>\\n':'')+'Essential \"instructions\"\\nKeep a \\\\ literal').replaceAll('\\n',process.env.BODY==='complete CRLF'?'\\r\\n':'\\n');\nconst valid=(process.env.BODY.startsWith('complete')||process.env.BODY==='closed early');\nconst instructions=valid?'  <instructions>\\n    '+body+'\\n  </instructions>\\n\\n':'';\nconst output='<activated_skill name=\"reverse-engineer-anything\">\\n'+instructions+'  <available_resources>\\n    '+skill+(process.env.BODY==='closed early'?'</activated_skill>':'')+(process.env.BODY==='inside resources'?body:'')+'\\n  </available_resources>\\n</activated_skill>'+(process.env.BODY==='outside wrapper'?body:'');\nconst responses=[{functionResponse:{name:'activate_skill',response:{output}}},...(process.env.BODY==='split messages'?[{functionResponse:{name:'activate_skill',response:{output:body}}}]:[])];\nconst second=await globalThis.fakeRequest({body:{contents:[{parts:responses}]},tools});const payload=output;\nawait writeFile(process.env.STATE+'/observed.json',JSON.stringify({first,second,payload}));throw Error('intentional stop before client mutation');},async close(){}};}\n".replace(
          "REPLACE_CONTRACTS",
          JSON.stringify(
            new URL("../../../dist/contracts/toolContracts.js", import.meta.url)
              .href,
          ),
        );
      await writeFile(join(state, "commands.mjs"), commands);
      await writeFile(
        join(state, "fixture.mjs"),
        "export async function createGeminiModelFixture({onRequest}){globalThis.fakeRequest=onRequest;return {baseUrl:'http://127.0.0.1:1',async close(){}};}\n",
      );
      await writeFile(
        join(state, "hook.mjs"),
        "import{registerHooks}from'node:module';import{pathToFileURL}from'node:url';registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/verify-gemini-client.mjs')){let f;if(specifier==='./lib/verify-commands.mjs')f='commands.mjs';if(specifier==='./verify/clients/gemini-model-fixture.mjs')f='fixture.mjs';if(f)return{url:pathToFileURL(process.env.STATE+'/'+f).href,shortCircuit:true};}return next(specifier,context);}});\n",
      );
      const script = fileURLToPath(
        new URL("../../../scripts/verify-gemini-client.mjs", import.meta.url),
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
            BODY: body,
            TMPDIR: state,
            TMP: state,
            TEMP: state,
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
        expect(observed.second[0].functionCall.name).toBe(
          "rea__analyze_javascript_application",
        );
      expect(result.stderr).toContain(
        allowed
          ? "intentional stop before client mutation"
          : "Gemini must load the installed personal REA skill",
      );
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  },
);

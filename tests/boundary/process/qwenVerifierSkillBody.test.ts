import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  ["no skill tool", false],
  ["user mention", false],
  ["wrong id", false],
  ["missing body", false],
  ["split", false],
  ["complete", true],
  ["CRLF", true],
  ["output missing result", false],
  ["output missing marker", false],
  ["output terminal failure", false],
  ["output success", true],
] as const)("binds Qwen skill evidence for %s", async (mode, loaded) => {
  const state = await mkdtemp(join(tmpdir(), "rea-qwen-skill-"));
  try {
    await writeFile(
      join(state, "commands.mjs"),
      "import {mkdir,readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';\nexport async function createVerifierCommands(){return {async exec(command,args,options={}){\n if(args.includes('--version'))return {stdout:'fake',stderr:''};\n const profile=options.env.QWEN_HOME;const config=join(profile,'settings.json');\n if(args.includes('setup')&&args.includes('--dry-run'))return {stdout:JSON.stringify({plannedActions:[{target:config}]}),stderr:''};\n if(args.includes('setup')){\n  const original=await readFile(config,'utf8');await writeFile(config+'.rea.backup',original);\n  const value=JSON.parse(original);value.mcpServers.rea={command:'/fake/rea',args:['mcp']};await writeFile(config,JSON.stringify(value));\n  const skill=join(options.env.HOME,'.agents','skills','reverse-engineer-anything');await mkdir(skill,{recursive:true});\n  const source='---\\nname: reverse-engineer-anything\\n---\\nQwen \"authored\" body\\nKeep a \\\\ literal\\n';\n  await writeFile(join(skill,'SKILL.md'),process.env.MODE==='CRLF'?source.replaceAll('\\n','\\r\\n'):source);\n  return {stdout:'{}',stderr:''};\n }\n if(args.includes('doctor'))return {stdout:'{}',stderr:''};\n if(process.env.MODE.startsWith('output ')){await globalThis.fakeRequest({body:{messages:[]},tools:[],requestIndex:1});const {TOOL_CONTRACTS}=await import(process.env.CONTRACTS);const events=[{type:'system',subtype:'init',tools:TOOL_CONTRACTS.map(c=>'mcp__rea__'+c.name)}];const success={type:'result',subtype:'success',is_error:false,result:process.env.MODE==='output missing marker'?'': 'REA_CLIENT_COMPATIBILITY_OK'};if(process.env.MODE!=='output missing result')events.push(success);if(process.env.MODE==='output terminal failure')events.push({type:'result',subtype:'error_during_execution',is_error:true});return {stdout:events.map(e=>JSON.stringify(e)).join('\\n')+'\\n',stderr:''};}\n const skill=join(options.env.HOME,'.agents','skills','reverse-engineer-anything');\n const content='Base directory for this skill: '+skill+'\\nImportant: ALWAYS resolve absolute paths from this base directory when working with skills.\\n\\nQwen \"authored\" body\\nKeep a \\\\ literal\\n';\n const tools=[...(process.env.MODE==='no skill tool'?[]:[{name:'skill'}]),{name:'mcp__rea__analyze_javascript_application'}];\n const first=await globalThis.fakeRequest({body:{messages:[]},tools,requestIndex:1});const callId=first.tool_calls[0].id;\n let messages=(process.env.MODE==='user mention'||process.env.MODE==='no skill tool')?[{role:'user',content:'Unrelated '+skill}]:[{role:'tool',tool_call_id:process.env.MODE==='wrong id'?'other':callId,content:process.env.MODE==='missing body'?'Base directory for this skill: '+skill:content}];\n if(process.env.MODE==='split')messages=[{role:'tool',tool_call_id:callId,content:'Base directory for this skill: '+skill},{role:'tool',tool_call_id:'other',content}];\n const second=await globalThis.fakeRequest({body:{messages},tools,requestIndex:2});await writeFile(process.env.STATE+'/observed.json',JSON.stringify({first,second,messages}));throw Error('intentional stop before client output');\n},async close(){}};}\n",
    );
    await writeFile(
      join(state, "fixture.mjs"),
      "export async function createOpenAiModelFixture({onRequest}){globalThis.fakeRequest=onRequest;return {baseUrl:'http://127.0.0.1:1',async close(){}};}\n",
    );
    await writeFile(
      join(state, "hook.mjs"),
      "import {registerHooks}from'node:module';import{pathToFileURL}from'node:url';registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/verify-qwen-client.mjs')){let f;if(specifier==='./lib/verify-commands.mjs')f='commands.mjs';if(specifier==='./verify/clients/model-fixture.mjs')f='fixture.mjs';if(f)return{url:pathToFileURL(process.env.STATE+'/'+f).href,shortCircuit:true};}return next(specifier,context);}});\n",
    );
    const script = fileURLToPath(
      new URL("../../../scripts/verify-qwen-client.mjs", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(state, "hook.mjs"),
        script,
        ...(mode.startsWith("output ") ? ["chat"] : []),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          STATE: state,
          MODE: mode,
          CONTRACTS: new URL(
            "../../../dist/contracts/toolContracts.js",
            import.meta.url,
          ).href,
          TMPDIR: state,
          TMP: state,
          TEMP: state,
        },
      },
    );
    if (mode.startsWith("output ")) {
      // Authored stream result shape from Qwen's BaseJsonOutputAdapter at
      // QwenLM/qwen-code c238beb56fa3c65a0f62ad7a3b2cd14db978b998.
      expect(result.status, result.stderr).toBe(loaded ? 0 : 1);
      const receipt = JSON.parse(result.stdout.trim().split("\n")[0] ?? "");
      expect(receipt.finalSeen).toBe(loaded);
      expect(receipt.passed).toBe(loaded);
      return;
    }
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("intentional stop before client output");
    const receipt = JSON.parse(result.stdout.trim().split("\n")[0] ?? "");
    expect(receipt.selectedSkillLoaded).toBe(loaded);
    expect(receipt.passed).toBe(false);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

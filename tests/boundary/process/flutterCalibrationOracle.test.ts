import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it.each(["complete", "wrong offset", "unrelated section"])(
  "checks Flutter overview against the independent section oracle (%s)",
  async (mode) => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-flutter-calibration-oracle-"),
    );
    try {
      const section = {
        name: "_kDartIsolateSnapshotData",
        offset: 64,
        size: 128,
      };
      await writeFile(
        join(directory, "oracle.json"),
        JSON.stringify({
          artifact_sha256: "a",
          libapp_sha256: "b",
          abi: "arm64-v8a",
          section,
        }),
      );
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({
          task: "overview",
          artifact: "authored.apk",
          oracle: join(directory, "oracle.json"),
          reply_receipt: join(directory, "reply.json"),
        }),
      );
      // Recorded provider replies isolate the verifier's independent oracle;
      // they do not qualify Flutter parsing, memory, timing or real APKs.
      await writeFile(
        join(directory, "reply.mjs"),
        `
export class FlutterBuildAnalysisService {async execute(){return {ok:true,value:{normalized_result:{target:{sha256:'a'},libapp:{sha256:'b',sections:[{name:process.env.MODE==='unrelated section'?'unrelated':'_kDartIsolateSnapshotData',offset:process.env.MODE==='wrong offset'?65:64,size:128}]},abi:'arm64-v8a',string_pool:{policy:{run_bytes:1024,token_bytes:128,token_limit:2000},coverage:'complete',package_uris:[],package_uri_count_at_least:0}}}};}}
export const createFlutterBuildAnalysisProvider=()=>({async close(){}});
export const estimateTokenCount=()=>0;
`,
      );
      await writeFile(
        join(directory, "hook.mjs"),
        `
import {registerHooks} from 'node:module';import {pathToFileURL} from 'node:url';
registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/flutter-budget-calibration/task.mjs')&&['FlutterBuildAnalysisService.ts','composition/flutter.ts','tokenx/dist/index.mjs'].some(end=>specifier.endsWith(end)))return {shortCircuit:true,url:pathToFileURL(process.env.RECORDING).href};return next(specifier,context);}});
`,
      );
      const result = execute(
        process.execPath,
        [
          "--import",
          join(directory, "hook.mjs"),
          fileURLToPath(
            new URL(
              "../../../scripts/verify/analysis/flutter-budget-calibration/task.mjs",
              import.meta.url,
            ),
          ),
          directory,
          join(directory, "config.json"),
        ],
        {
          timeout: 10_000,
          env: {
            ...process.env,
            MODE: mode,
            RECORDING: join(directory, "reply.mjs"),
          },
        },
      );
      if (mode === "complete")
        expect(JSON.parse((await result).stdout)).toMatchObject({
          task: "overview",
          success: true,
          call_count: 1,
        });
      else
        await expect(result).rejects.toMatchObject({
          stderr: expect.stringContaining(
            mode === "wrong offset"
              ? "differs from the independent ELF oracle"
              : "omitted the independently pinned snapshot section",
          ),
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

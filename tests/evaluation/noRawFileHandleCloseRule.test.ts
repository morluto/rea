import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/no-raw-file-handle-close.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "no-raw-file-handle-close",
  rule,
  {
    valid: [
      // Owned closes, unrelated close methods and shadowed names.
      'import { open } from "node:fs/promises"; const owner = new OwnedFileHandle(await open("x")); await owner.close();',
      "server.close(); transport.close();",
      'import { open } from "./local.js"; const h = await open("x"); await h.close();',
      'const open = async (p: string) => ({ close() {} }); const h = await open("x"); h.close();',
      'import type { FileHandle } from "./local.js"; const f = (h: FileHandle) => h.close();',
      "class C { readonly x: { close(): void }; d() { this.x.close(); } }",
      'import { close } from "./local.js"; close(1);',
    ],
    invalid: [
      {
        code: 'import { open } from "node:fs/promises"; const h = await open("x"); await h.close();',
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'import * as fsp from "node:fs/promises"; let h; h = await fsp.open("x"); await h.close();',
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'import { open } from "fs/promises"; await (await open("x")).close();',
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'import { open } from "node:fs/promises"; const h = await open("x").catch(() => { throw new Error(); }); await h.close();',
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'import type { FileHandle } from "node:fs/promises"; const f = async (h: FileHandle | undefined) => h?.close();',
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'import type * as fsp from "node:fs/promises"; const f = (h: fsp.FileHandle) => h.close();',
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'import type { FileHandle } from "node:fs/promises"; class C { #h: FileHandle; async d() { await this.#h.close(); } }',
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'import { closeSync } from "node:fs"; closeSync(3);',
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'import * as fs from "fs"; fs.close(3, () => {});',
        errors: [{ messageId: "raw" }],
      },
    ],
  },
);

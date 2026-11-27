import { expect, it } from "vitest";

import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { run, session } from "./kunaSessionFixture.js";

it.skipIf(process.platform === "win32").each([
  { bytes: [0xff], valid: false },
  { bytes: [...Buffer.from("�Δ")], valid: true },
])(
  "keeps cached function text faithful to its source bytes ($valid)",
  async ({ bytes, valid }) => {
    const { open } = await session("rea-kuna-project-text-", {
      cBodyComment: bytes,
    });
    const client = open();

    // Assembly requires the published project. The next query therefore reads
    // the verified on-disk .c span instead of a cold subprocess response.
    const assembly = await run(client, "procedure_assembly", {
      procedure: "main",
    });
    expect(assembly.rawResult).toMatchObject({
      source: { kind: "project-export" },
    });
    const result = await client.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    if (valid) {
      expect(result).toMatchObject({
        ok: true,
        value: {
          result: expect.stringContaining("/*�Δ*/"),
          rawResult: { source: { kind: "project-export" } },
        },
      });
    } else {
      expect(result).toMatchObject({
        ok: false,
        error: {
          cause: { code: "invalid_utf8", kind: "malformed" },
          diagnostics: {
            file: expect.stringMatching(/program\.c$/u),
            byte_offset: Buffer.byteLength('#include "program.h"\n\n'),
            byte_length: expect.any(Number),
          },
        },
      });
    }
    // An unreadable C body does not invalidate independently verified assembly.
    const again = await run(client, "procedure_assembly", {
      procedure: "main",
    });
    expect(again.result).toEqual(assembly.result);
  },
);

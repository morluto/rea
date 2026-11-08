import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { evaluateTaskChecks } from "./appTaskChecks.js";
import { VALUE_LIMITS } from "./appTaskDraftValues.js";
import {
  buildSecretHandleSchema,
  redactSecrets,
  redactSecretsInJson,
  secretValueRefusal,
  secretsIn,
} from "./buildSecrets.js";
import { compactValue, cut } from "./compactValue.js";
import { CHECK_VALUE_CHARS, DRAFT_VIEW_CHARS } from "./valueCuts.js";

// Made-up test values, never a real credential.
const VALUE = "e-Plum7 Kite/Throw+away?42";
const ACCENTED = "e-Clé-Ünïcode-Fake-9";
const SECRETS = [
  { handle: "master", value: VALUE },
  { handle: "licence", value: ACCENTED },
];

const found = (bytes: Uint8Array | string) =>
  secretsIn(typeof bytes === "string" ? Buffer.from(bytes) : bytes, SECRETS);

const swapped = (bytes: Buffer): Buffer => Buffer.from(bytes).swap16();

describe("build secrets", () => {
  it("takes handles that name one file of the secrets folder", () => {
    for (const handle of ["keepassxc-master", "varicad.login", "a", "k_2"])
      expect(buildSecretHandleSchema.safeParse(handle).success, handle).toBe(
        true,
      );
    for (const handle of [
      "",
      "../x",
      "A",
      "-x",
      ".hidden",
      "a/b",
      "x".repeat(64),
    ])
      expect(buildSecretHandleSchema.safeParse(handle).success, handle).toBe(
        false,
      );
  });

  it("refuses values a scan could not tell from ordinary text or a keyboard could not type", () => {
    expect(secretValueRefusal(VALUE)).toBeUndefined();
    expect(secretValueRefusal("short")).toContain("8");
    expect(secretValueRefusal("two\nlines here")).toContain("control");
    expect(secretValueRefusal("x".repeat(1025))).toContain("1024");
  });

  it("finds a value as it is, in UTF-16, in hex, in URL encoding and escaped in JSON", () => {
    expect(found(`pass=${VALUE};`)).toEqual(["master"]);
    expect(found(Buffer.from(`<${VALUE}>`, "utf16le"))).toEqual(["master"]);
    expect(found(swapped(Buffer.from(`<${VALUE}>`, "utf16le")))).toEqual([
      "master",
    ]);
    const hex = Buffer.from(VALUE).toString("hex");
    expect(found(`7b22${hex}227d`)).toEqual(["master"]);
    expect(found(hex.toUpperCase())).toEqual(["master"]);
    expect(found(`q=${encodeURIComponent(VALUE)}&x=1`)).toEqual(["master"]);
    expect(
      found(`q=${encodeURIComponent(VALUE).replaceAll("%20", "+")}`),
    ).toEqual(["master"]);
    expect(
      found(
        encodeURIComponent(VALUE).replace(/%[0-9A-F]{2}/gu, (escape) =>
          escape.toLowerCase(),
        ),
      ),
    ).toEqual(["master"]);
    const quoted = 'e-say "hi" \\ there';
    expect(
      secretsIn(Buffer.from(JSON.stringify({ note: `a ${quoted} b` })), [
        { handle: "quoted", value: quoted },
      ]),
    ).toEqual(["quoted"]);
    expect(found(Buffer.from(ACCENTED, "utf16le"))).toEqual(["licence"]);
    expect(found(Buffer.from(ACCENTED).toString("hex"))).toEqual(["licence"]);
  });

  it("finds a value base64-encoded at any byte alignment, in either alphabet", () => {
    for (const prefix of ["", "a", "ab", "abc"]) {
      const encoded = Buffer.from(`${prefix}${VALUE}tail`).toString("base64");
      expect(found(`token:${encoded}`), prefix).toEqual(["master"]);
      const url = Buffer.from(`${prefix}${VALUE}`).toString("base64url");
      expect(found(url), prefix).toEqual(["master"]);
    }
  });

  it("finds a value inside a gzip file", () => {
    expect(found(gzipSync(Buffer.from(`[auth]\nkey=${VALUE}\n`)))).toEqual([
      "master",
    ]);
  });

  it("finds neither a near miss nor unrelated bytes", () => {
    expect(found(VALUE.slice(0, -1))).toEqual([]);
    expect(found(Buffer.from(VALUE.slice(1)).toString("base64"))).toEqual([]);
    expect(found("[ui]\nwrap=true\n")).toEqual([]);
    expect(secretsIn(Buffer.from(VALUE), [])).toEqual([]);
  });

  it("replaces each spelling of a value in text and JSON with its handle", () => {
    const hex = Buffer.from(VALUE).toString("hex");
    expect(redactSecrets(`typed ${VALUE}, stored ${hex}`, SECRETS)).toBe(
      "typed <secret:master>, stored <secret:master>",
    );
    expect(redactSecrets(`q=${encodeURIComponent(VALUE)}`, SECRETS)).toBe(
      "q=<secret:master>",
    );
    expect(redactSecrets("nothing here", SECRETS)).toBe("nothing here");
    expect(
      redactSecretsInJson(
        { [VALUE]: [`x ${ACCENTED}`, 3, null, { ok: true }] },
        SECRETS,
      ),
    ).toEqual({
      "<secret:master>": ["x <secret:licence>", 3, null, { ok: true }],
    });
    const redacted = JSON.stringify(
      redactSecretsInJson({ text: `${VALUE} and ${ACCENTED}` }, SECRETS),
    );
    expect(redacted).not.toContain(VALUE);
    expect(redacted).not.toContain(ACCENTED);
  });
});

describe("build secrets in text REA cut short", () => {
  it("still hides the start of a secret each of REA's cuts leaves before its ellipsis, at any length", () => {
    // A made-up 800-character value, longer than any cut keeps.
    const long = `e-${"Fake9Kite".repeat(88)}x`;
    const secrets = [{ handle: "long", value: long }];
    /** The text redacted as a structured string, as a JSON member and in a result's JSON text. */
    const hidden = (
      text: string,
      expected: string,
      label: string,
      known = secrets,
    ) => {
      expect(redactSecrets(text, known), label).toBe(expected);
      expect(redactSecretsInJson({ after: text }, known), label).toEqual({
        after: expected,
      });
      expect(redactSecrets(JSON.stringify({ after: text }), known), label).toBe(
        JSON.stringify({ after: expected }),
      );
    };
    for (const kept of [600, 190, 37, 1]) {
      const pad = "a".repeat(600 - kept);
      hidden(
        compactValue(`${pad}${long}`, VALUE_LIMITS.chars, "json") as string,
        `${pad}<secret:long>…`,
        `draft value ${String(kept)}`,
      );
      const tag = `<account><name>${"b".repeat(585 - Math.min(kept, 585))}`;
      hidden(
        cut(`${tag}${long}`, VALUE_LIMITS.chars),
        `${tag}<secret:long>…`,
        `reference ${String(kept)}`,
      );
      const view = "c".repeat(DRAFT_VIEW_CHARS - kept);
      hidden(
        cut(`${view}${long}`, DRAFT_VIEW_CHARS),
        `${view}<secret:long>…`,
        `view ${String(kept)}`,
      );
    }
    for (const kept of [190, 37, 1]) {
      // A string's JSON opens with its quote, which the cut keeps first.
      const pad = "d".repeat(CHECK_VALUE_CHARS - 1 - kept);
      const [outcome] = evaluateTaskChecks(
        [
          {
            id: "check-1",
            kind: "value_equals",
            file: "settings.json",
            pointer: "/pw",
            value: "other",
          },
        ],
        new Map([
          ["settings.json", { format: "json", view: { pw: `${pad}${long}` } }],
        ]),
      );
      const description = outcome?.description ?? "";
      expect(description).toContain(`"${pad}${long.slice(0, kept)}…`);
      hidden(
        description,
        description.replace(
          `"${pad}${long.slice(0, kept)}…`,
          `"${pad}<secret:long>…`,
        ),
        `check ${String(kept)}`,
      );
    }
    // A cut inside an escape: an XML value's `&lt;`, and a JSON value's `\"`.
    const marked = 'e-a&b<c"d-Fake';
    hidden(
      compactValue(
        {
          name: "p",
          attributes: {},
          children: [`${"f".repeat(586)}${marked}`],
        },
        VALUE_LIMITS.chars,
        "xml",
      ) as string,
      `<p>${"f".repeat(586)}<secret:xml>…`,
      "xml escape",
      [{ handle: "xml", value: marked }],
    );
    const quoted = 'e-say"hi"\\now-Fake';
    hidden(
      compactValue(
        { pw: `${"g".repeat(585)}${quoted}` },
        VALUE_LIMITS.chars,
        "json",
      ) as string,
      `{"pw":"${"g".repeat(585)}<secret:quoted>…`,
      "json escape",
      [{ handle: "quoted", value: quoted }],
    );
  });

  it("leaves ordinary text ending in an ellipsis whole, though it ends as a secret begins", () => {
    // VALUE and ACCENTED begin with "e", as "Please" and "Open Recent File" end.
    for (const text of [
      "Please…",
      "Open Recent File…",
      `${"word ".repeat(150)}Please…`,
    ]) {
      expect(redactSecrets(text, SECRETS)).toBe(text);
      expect(redactSecretsInJson({ title: text }, SECRETS)).toEqual({
        title: text,
      });
      expect(redactSecrets(JSON.stringify({ title: text }), SECRETS)).toBe(
        JSON.stringify({ title: text }),
      );
    }
  });
});

describe("build secrets in escaped text", () => {
  it("replaces a value's XML-escaped and twice JSON-escaped spellings", () => {
    const long = `e-${"Fake9Kite".repeat(88)}x`;
    const secrets = [{ handle: "long", value: long }];
    const marked = 'e-a&b<c"d-Fake';
    expect(
      redactSecrets(
        `<p title="${marked.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")}">`,
        [{ handle: "xml", value: marked }],
      ),
    ).toBe('<p title="<secret:xml>">');
    expect(redactSecrets("text… unrelated", secrets)).toBe("text… unrelated");
    const quoted = 'e-say"hi"\\now-Fake';
    expect(
      redactSecrets(JSON.stringify({ after: JSON.stringify({ pw: quoted }) }), [
        { handle: "quoted", value: quoted },
      ]),
    ).toBe(
      JSON.stringify({ after: JSON.stringify({ pw: "<secret:quoted>" }) }),
    );
  });

  it("never treats an empty or short value as one to find", () => {
    const empty = [
      { handle: "empty", value: "" },
      { handle: "short", value: "ab" },
    ];
    expect(redactSecrets("abc def", empty)).toBe("abc def");
    expect(secretsIn(Buffer.from("abc def"), empty)).toEqual([]);
  });
});

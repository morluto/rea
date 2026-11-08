import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  buildSecretHandleSchema,
  redactSecrets,
  redactSecretsInJson,
  secretValueRefusal,
  secretsIn,
} from "./buildSecrets.js";

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

  it("finds and redacts declared form-encoded secrets without altering unmarked values", () => {
    const value = "e-Fake!Password~42 a";
    const secrets = [{ handle: "master", value }];
    const encoded = new URLSearchParams([["q", value]]).toString().slice(2);
    for (const spelling of [
      encoded,
      encoded.replace(/%[0-9A-F]{2}/gu, (part) => part.toLowerCase()),
    ]) {
      const text = `q=${spelling}`;
      expect(secretsIn(Buffer.from(text), secrets)).toEqual(["master"]);
      expect(redactSecrets(text, secrets)).toBe("q=<secret:master>");
      expect(secretsIn(Buffer.from(text), [])).toEqual([]);
      expect(redactSecrets(text, [])).toBe(text);
    }
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

it("preserves ordinary text ending at a draft boundary", () => {
  const text = `${"x".repeat(599)}e…`;
  expect(redactSecrets(text, SECRETS)).toBe(text);
  expect(redactSecretsInJson({ text }, SECRETS)).toEqual({ text });
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

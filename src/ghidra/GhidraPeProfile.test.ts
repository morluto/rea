import { expect, it } from "vitest";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ghidraPePdbLimitations } from "./GhidraPeProfile.js";
import {
  ghidraPdbLimitations,
  type GhidraSessionInfo,
} from "./GhidraSessionValues.js";

const target = {
  path: "/fixture/public.exe",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  executableRole: "application",
  managed: false,
  codeView: {
    pdbPath: "C:\\symbols\\public.pdb",
    pdbFileName: "public.pdb",
    guid: "01234567-89ab-cdef-0123-456789abcdef",
    age: 10,
  },
} satisfies BinaryTarget;
const absentAttributes = {
  file: null,
  guid: null,
  age: null,
  signature: null,
  version: null,
  loaded: null,
};

it("preserves undecodable PE locator bytes apart from Ghidra's reported file", () => {
  const caveats = ghidraPePdbLimitations(
    {
      ...target,
      codeView: {
        pdbPath: null,
        pdbFileName: null,
        pdbPathBytesHex: "e92e706462",
        guid: target.codeView?.guid ?? null,
        age: 10,
      },
    },
    {
      ...absentAttributes,
      file: "é.pdb",
      guid: target.codeView?.guid ?? null,
      age: "a",
      loaded: true,
    },
  );
  expect(caveats).toHaveLength(2);
  expect(caveats[0]).toContain("é.pdb");
  expect(caveats[1]).toContain(
    "path encoding unknown; original path bytes 0xe92e706462",
  );
  expect(caveats[1]).toContain("equivalence is not established");
});

it.each(["file", "guid", "age"] as const)(
  "retains declared identity when only reported %s is omitted",
  (attribute) => {
    const pdb: GhidraSessionInfo["pdb"] = {
      file: "public.pdb",
      guid: "0123456789abcdef0123456789abcdef",
      age: "a",
      signature: null,
      version: "RSDS",
      loaded: null,
      resource_limit: { omitted_attributes: [attribute], utf16_budget: 4096 },
      [attribute]: null,
    };
    const caveats = ghidraPePdbLimitations(target, pdb).join(" ");
    expect(caveats).toContain("omitted");
    expect(caveats).toContain('PDB "public.pdb"');
    expect(caveats).toContain("01234567-89ab-cdef-0123-456789abcdef");
    expect(caveats).toContain("load state unknown");
  },
);

it.each([undefined, absentAttributes])(
  "retains declared identity and unknown load state when reported attributes are %j",
  (pdb) => {
    const caveats = ghidraPePdbLimitations(target, pdb);
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain(
      'PDB "public.pdb" (GUID 01234567-89ab-cdef-0123-456789abcdef, age (decimal) 10)',
    );
    expect(caveats[0]).toContain("load state unknown");
    expect(caveats[0]).not.toContain("were not applied");
    expect(caveats[0]).not.toContain("names are analysis-generated");
  },
);

it.each([true, false, null])(
  "uses reported PDB observations once with loaded = %s",
  (loaded) => {
    const pdb = {
      file: "public.pdb",
      guid: "{01234567-89AB-CDEF-0123-456789ABCDEF}",
      age: "0X000A",
      signature: null,
      version: "RSDS",
      loaded,
    };
    const caveats = ghidraPePdbLimitations(target, pdb);
    expect(caveats).toEqual(ghidraPdbLimitations(pdb));
    expect(caveats).toHaveLength(1);
    const warning = caveats[0] ?? "";
    expect(warning).toContain("public.pdb");
    expect(warning).toContain("list_procedures");
    expect(warning).toMatch(/names and types may (?:still )?be missing/i);
    expect(warning).toMatch(/empty name search does not prove/i);
    if (loaded === true) {
      expect(warning).toMatch(/loaded PDB/i);
      expect(warning).toMatch(/not an independent PDB identity/i);
    } else if (loaded === false) {
      expect(warning).toMatch(/not loaded/i);
    } else {
      expect(warning).toMatch(/load state unknown/i);
    }
    expect(warning).not.toContain('PDB "public.pdb"');
  },
);

it.each([
  { file: "different.pdb", guid: "0123456789abcdef0123456789abcdef", age: "a" },
  { file: "public.pdb", guid: "1123456789abcdef0123456789abcdef", age: "a" },
  { file: "public.pdb", guid: "0123456789abcdef0123456789abcdef", age: "10" },
  { file: "public.pdb", guid: "unrecognized-guid", age: "a" },
  { file: "public.pdb", guid: "0123456789abcdef0123456789abcdef", age: "ten" },
])("retains non-equivalent declared PDB identity for %j", (identity) => {
  const pdb = {
    ...absentAttributes,
    ...identity,
    version: "RSDS",
    loaded: true,
  };
  const caveats = ghidraPePdbLimitations(target, pdb);
  expect(caveats).toEqual([
    ...ghidraPdbLimitations(pdb),
    expect.stringContaining('PDB "public.pdb"'),
  ]);
  expect(caveats[0]).toContain(identity.file);
  expect(caveats[0]).toContain(identity.guid);
  expect(caveats[0]).toContain(`age (hex) ${identity.age}`);
  expect(caveats[1]).toContain("01234567-89ab-cdef-0123-456789abcdef");
  expect(caveats[1]).toContain("age (decimal) 10");
  expect(caveats[1]).toContain("equivalence is not established");
  expect(pdb).toMatchObject({ ...identity, loaded: true });
});

it.each([
  ["public.pdb", "0123456789ABCDEF0123456789ABCDEF"],
  ["C:\\symbols\\public.pdb", "01234567-89ab-cdef-0123-456789abcdef"],
])("recognizes the declared locator %s and normalized GUID", (file, guid) => {
  const pdb = { ...absentAttributes, file, guid, age: "a" };
  expect(ghidraPePdbLimitations(target, pdb)).toEqual(
    ghidraPdbLimitations(pdb),
  );
});

it("retains explicit failure to load without asserting all names are generated", () => {
  const caveats = ghidraPePdbLimitations(target, {
    ...absentAttributes,
    loaded: false,
  });
  expect(caveats[0]).toContain("reports not loaded");
  expect(caveats[0]).not.toContain("names are analysis-generated");
});

it("retains a loaded-state attestation caveat even when reference attributes are absent", () => {
  const caveats = ghidraPePdbLimitations(target, {
    ...absentAttributes,
    loaded: true,
  });
  expect(caveats[0]).toEqual(
    ghidraPdbLimitations({ ...absentAttributes, loaded: true })[0],
  );
  expect(caveats).toHaveLength(2);
  expect(caveats[1]).toContain('PDB "public.pdb"');
  expect(caveats[0]).toContain("not an independent PDB identity");
  expect(caveats[0]).not.toContain("reports not loaded");
});

it("preserves omitted-attribute resource coverage with declared fallback identity", () => {
  const pdb: GhidraSessionInfo["pdb"] = {
    ...absentAttributes,
    resource_limit: { omitted_attributes: ["file"], utf16_budget: 4096 },
  };
  const caveats = ghidraPePdbLimitations(target, pdb);
  expect(caveats).toHaveLength(2);
  expect(caveats[0]).toContain("omitted");
  expect(caveats[1]).toContain("public.pdb");
});

it("reports NB10 declared age without inventing a GUID", () => {
  const caveats = ghidraPePdbLimitations(
    {
      ...target,
      codeView: {
        pdbPath: "legacy.pdb",
        pdbFileName: "legacy.pdb",
        guid: null,
        age: 2,
      },
    },
    undefined,
  );
  expect(caveats[0]).toContain('PDB "legacy.pdb" (age (decimal) 2)');
  expect(caveats[0]).not.toContain("GUID");
});

it("keeps a budget-omitted NB10 GUID unknown", () => {
  const pdbPath = "a".repeat(4070) + "\\legacy.pdb";
  const legacy = {
    ...target,
    codeView: {
      pdbPath,
      pdbFileName: "legacy.pdb",
      guid: null,
      age: 2,
    },
  };
  const pdb = {
    ...absentAttributes,
    file: pdbPath,
    age: "2",
    signature: "01234567",
    version: "NB10",
    loaded: null,
  };
  expect(ghidraPePdbLimitations(legacy, pdb)).toEqual(
    ghidraPdbLimitations(pdb),
  );
  const omitted: GhidraSessionInfo["pdb"] = {
    ...pdb,
    resource_limit: { omitted_attributes: ["guid"], utf16_budget: 4096 },
  };
  const caveats = ghidraPePdbLimitations(legacy, omitted);
  expect(caveats).toEqual([
    ...ghidraPdbLimitations(omitted),
    expect.stringContaining('PDB "legacy.pdb" (age (decimal) 2)'),
  ]);
  expect(caveats.at(-1)).toContain("equivalence is not established");
});

it.each(["signature", "version"] as const)(
  "keeps matching NB10 identity when only %s is omitted",
  (attribute) => {
    const legacy = {
      ...target,
      codeView: {
        pdbPath: "legacy.pdb",
        pdbFileName: "legacy.pdb",
        guid: null,
        age: 2,
      },
    };
    const pdb: GhidraSessionInfo["pdb"] = {
      ...absentAttributes,
      file: "legacy.pdb",
      age: "2",
      resource_limit: { omitted_attributes: [attribute], utf16_budget: 4096 },
    };
    expect(ghidraPePdbLimitations(legacy, pdb)).toEqual(
      ghidraPdbLimitations(pdb),
    );
  },
);

it("retains missing-report uncertainty without a declared CodeView record", () => {
  const { codeView: _, ...withoutReference } = target;
  const caveats = ghidraPePdbLimitations(withoutReference, undefined);
  expect(caveats).toEqual(ghidraPdbLimitations(undefined));
  expect(caveats).toContainEqual(
    expect.stringMatching(
      /did not report PDB attributes.*coverage is unknown/i,
    ),
  );
});

it("adds no PDB warning for a non-PE target", () => {
  const elf: BinaryTarget = {
    path: "/fixture/program",
    sha256: "a".repeat(64),
    kind: "executable",
    format: "elf",
    architecture: "x86_64",
    availableArchitectures: ["x86_64"],
  };
  expect(ghidraPePdbLimitations(elf, undefined)).toEqual([]);
});

it.each([
  ["ASCII beyond the conservative shortcut", "a".repeat(171)],
  ["ASCII at the byte budget", "a".repeat(1022)],
  ["ASCII beyond the byte budget", "a".repeat(1023)],
  ["quotes at the byte budget", '"'.repeat(511)],
  ["quotes beyond the byte budget", '"'.repeat(512)],
  ["multibyte text beyond the byte budget", "中".repeat(341)],
])("uses actual JSON UTF-8 size for %s", (_, name) => {
  const selected = {
    ...target,
    codeView: { ...target.codeView, pdbFileName: name },
  };
  const caveat = ghidraPePdbLimitations(selected, undefined).join(" ");
  const encoded = JSON.stringify(name);
  if (Buffer.byteLength(encoded) <= 1024) {
    expect(caveat).toContain(`PDB ${encoded} (`);
  } else {
    expect(caveat).toContain("1024-byte resource budget");
    expect(caveat).not.toContain(encoded);
    expect(Buffer.byteLength(caveat)).toBeLessThan(1024);
  }
  expect(caveat).toContain("01234567-89ab-cdef-0123-456789abcdef");
  expect(selected.codeView.pdbFileName).toBe(name);
});

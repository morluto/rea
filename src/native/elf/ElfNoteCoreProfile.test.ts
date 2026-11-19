import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { inspectElfNotesInputSchema } from "../../domain/native/elfNotes.js";
import { parseElfNotes } from "./ElfNoteParser.js";
import {
  coreAuxvNote,
  coreFileNote,
  corePrpsinfoNote,
  coreSiginfoNote,
  elfNoteFixture,
  gnuBuildIdNote,
} from "./ElfNotes.fixture.js";

const input = inspectElfNotesInputSchema.parse({ path: "/fixture.core" });
const parse = (bytes: Buffer) =>
  parseElfNotes(
    bytes,
    {
      path: input.path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    input,
  );

const fixture = () =>
  elfNoteFixture({
    type: 4,
    ownership: "both",
    notes: Buffer.concat([
      corePrpsinfoNote({ pid: 1234, uid: 70000, fname: "profile-control" }),
      coreSiginfoNote(11, 1, 0),
      coreFileNote([], 4096),
      coreAuxvNote([[6, 4096]]),
      gnuBuildIdNote("0123456789abcdef"),
    ]),
  });

it.each([
  { name: "Solaris", osabi: 6, version: 0 },
  { name: "FreeBSD", osabi: 9, version: 0 },
  { name: "unrecognized System V ABI version", osabi: 0, version: 1 },
  { name: "unrecognized Linux ABI version", osabi: 3, version: 1 },
])(
  "keeps $name CORE payloads uninterpreted in both tables",
  ({ osabi, version }) => {
    const bytes = fixture();
    const control = parse(bytes);
    bytes[7] = osabi;
    bytes[8] = version;
    const report = parse(bytes);
    const core = report.entries.filter(({ owner }) => owner === "CORE");
    expect(core).toHaveLength(8);
    for (const entry of core) {
      expect(entry.core).toBeNull();
      expect(entry.type_name).toBe("unknown");
    }
    expect(report.entries.map(({ descriptor }) => descriptor)).toEqual(
      control.entries.map(({ descriptor }) => descriptor),
    );
    expect(report.entries.filter(({ owner }) => owner === "GNU")).toEqual(
      control.entries.filter(({ owner }) => owner === "GNU"),
    );
    expect(report.coverage).toEqual(control.coverage);
    expect(report.limitations.join(" ")).toContain(`OSABI ${String(osabi)}`);
    expect(report.limitations.join(" ")).toContain(
      `ABI version ${String(version)}`,
    );
  },
);

it.each([0, 3])(
  "retains Linux CORE decoding for OSABI %i, ABI version zero",
  (osabi) => {
    const bytes = fixture();
    bytes[7] = osabi;
    const report = parse(bytes);
    const core = report.entries.filter(({ owner }) => owner === "CORE");
    expect(core).toHaveLength(8);
    expect(core.every(({ core: value }) => value !== null)).toBe(true);
    expect(core[0]?.core?.prpsinfo).toMatchObject({
      pid: 1234,
      uid: 70000,
      filename: "profile-control",
    });
    expect(report.limitations.join(" ")).not.toContain("not interpreted");
  },
);

it("does not attach a CORE refusal to a foreign profile containing only GNU notes", () => {
  const bytes = elfNoteFixture({ notes: gnuBuildIdNote("0123456789abcdef") });
  const control = parse(bytes);
  bytes[7] = 6;
  expect(parse(bytes).entries).toEqual(control.entries);
  expect(parse(bytes).limitations).toEqual(control.limitations);
});

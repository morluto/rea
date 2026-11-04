import { describe, expect, it } from "vitest";

import {
  detectStateFormat,
  keyfileView,
  textView,
  xmlView,
} from "./stateFormats.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("detectStateFormat", () => {
  it("recognises SQLite and dconf headers before decoding text", () => {
    expect(detectStateFormat("/h/a.db", bytes("SQLite format 3\0rest"))).toBe(
      "sqlite",
    );
    expect(detectStateFormat("/h/user", bytes("GVariant\0\0\0\0"))).toBe(
      "dconf",
    );
    expect(detectStateFormat("/h/blob", Uint8Array.of(1, 0, 2))).toBe("binary");
  });

  it("tells JSON, XML, key files and plain text apart", () => {
    expect(detectStateFormat("/h/a.json", bytes('{"a":1}'))).toBe("json");
    expect(detectStateFormat("/h/notes", bytes("{not json"))).toBe("text");
    expect(
      detectStateFormat("/h/a.xbel", bytes("<?xml version='1.0'?><x/>")),
    ).toBe("xml");
    expect(
      detectStateFormat("/h/settings", bytes("[General]\nwrap=true\n")),
    ).toBe("keyfile");
    expect(detectStateFormat("/h/todo.txt", bytes("milk\neggs\n"))).toBe(
      "text",
    );
  });
});

describe("views", () => {
  it("splits text into lines without a trailing empty line", () => {
    expect(textView("a\nb\n")).toEqual({
      lines: ["a", "b"],
      line_count: 2,
      truncated: false,
    });
  });

  it("reads key file groups, keeping keys before the first group", () => {
    expect(
      keyfileView("top=1\n# note\n[org/app]\nwrap = true\nfont='Mono 10'\n"),
    ).toEqual({
      "": { top: "1" },
      "org/app": { wrap: "true", font: "'Mono 10'" },
    });
  });

  it("reads XML into an element tree and refuses a DOCTYPE", () => {
    expect(xmlView('<a x="1"><b>text</b></a>')).toEqual({
      root: {
        name: "a",
        attributes: { x: "1" },
        children: [{ name: "b", attributes: {}, children: ["text"] }],
      },
      truncated: false,
    });
    expect(xmlView('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>')).toBeUndefined();
  });
});

describe("captured data safety and fidelity", () => {
  it("keeps a __proto__ group as plain data without touching Object.prototype", () => {
    const groups = keyfileView("[__proto__]\npolluted=yes\n");
    expect(Object.keys(groups)).toEqual(["__proto__"]);
    expect(groups["__proto__"]?.polluted).toBe("yes");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps XML text and leaf whitespace exactly, dropping only formatting between elements", () => {
    expect(
      xmlView(
        '<a>\n  <b> x </b><c xml:space="preserve">  </c><d>\n  </d>\n</a>',
      ),
    ).toEqual({
      root: {
        name: "a",
        attributes: {},
        children: [
          { name: "b", attributes: {}, children: [" x "] },
          {
            name: "c",
            attributes: { "xml:space": "preserve" },
            children: ["  "],
          },
          { name: "d", attributes: {}, children: ["\n  "] },
        ],
      },
      truncated: false,
    });
  });

  it("keeps whitespace runs a leaf's comments separate", () => {
    expect(xmlView("<a> <!--x--> <!--y--> </a>")).toEqual({
      root: { name: "a", attributes: {}, children: [" ", " ", " "] },
      truncated: false,
    });
  });

  it("marks a tree cut at the depth limit as truncated", () => {
    const deep = `${"<n>".repeat(70)}${"</n>".repeat(70)}`;
    expect(xmlView(deep)).toMatchObject({ truncated: true });
  });
});

import { describe, expect, it } from "vitest";

import {
  classifyReferenceSourcePath,
  detectReferenceSourceLanguage,
} from "./referenceSourceClassification.js";

describe("reference source test filenames", () => {
  it.each([
    ["main_test.go", ["source", "test"], "Go"],
    ["main_test.py", ["source", "test"], "Python"],
    ["parser_spec.rs", ["source", "test"], "Rust"],
    ["widget_spec.cpp", ["source", "test"], "C++"],
    ["Widget_TeSt.TS", ["source", "test"], "TypeScript"],
    ["Widget_SpEc.PY", ["source", "test"], "Python"],
    ["widget.v2_test.py", ["source", "test"], "Python"],
    [".widget_spec.js", ["source", "test"], "JavaScript"],
    ["widget_test.fixture", ["test"], null],
    ["settings_spec.json", ["config", "test"], "JSON"],
    ["notes_test.md", ["documentation", "test"], "Markdown"],
    ["widget_test.map", ["generated", "test"], null],
    ["dist/widget_spec.js", ["generated", "source", "test"], "JavaScript"],
    ["vendor/widget_test.go", ["source", "test", "vendor"], "Go"],
  ])("recognizes the final basename suffix in %s", (path, tags, language) => {
    expect(classifyReferenceSourcePath(path)).toEqual(tags);
    expect(detectReferenceSourceLanguage(path)).toBe(language);
  });

  it.each([
    ["test_main.py", ["source", "test"]],
    ["SPEC_main.rs", ["source", "test"]],
    ["main.test.js", ["source", "test"]],
    ["main.SPEC.ts", ["source", "test"]],
    ["main_test", ["test"]],
    ["main_SPEC", ["test"]],
    ["main.py_test", ["test"]],
    ["main.rs_spec", ["test"]],
    ["tests/main.go", ["source", "test"]],
  ])("preserves existing test classification for %s", (path, tags) => {
    expect(classifyReferenceSourcePath(path)).toEqual(tags);
  });

  it.each([
    ["main.go", ["source"]],
    ["main.py", ["source"]],
    ["main_test_helper.go", ["source"]],
    ["main_tests.go", ["source"]],
    ["main_testing.py", ["source"]],
    ["main_tester.py", ["source"]],
    ["main_spec_helper.rs", ["source"]],
    ["main_specs.rs", ["source"]],
    ["main_specimen.rs", ["source"]],
    ["main_test.py.bak", ["unknown"]],
    ["main_spec.ts.bak", ["unknown"]],
    ["main_test_helpers", ["unknown"]],
    ["main_spec_helpers", ["unknown"]],
  ])("does not infer a test from a near-name in %s", (path, tags) => {
    expect(classifyReferenceSourcePath(path)).toEqual(tags);
  });
});

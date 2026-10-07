import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe.each(["webPreferences", "serviceName"] as const)(
  "Electron %s option lookup",
  (name) => {
    const value =
      name === "webPreferences"
        ? '{ preload: "./kept.js", sandbox: true }'
        : '"kept"';
    const explicit = `${name}: ${value}`;
    const method = `${name}() { return ${value}; }`;
    const getter = `get ${name}() { return ${value}; }`;
    const setter = `set ${name}(value) {}`;

    const explicitCases = [
      ["plain key", explicit],
      ["quoted key", `"${name}": ${value}`],
      ["computed string key", `["${name}"]: ${value}`],
      ["duplicate key", `${name}: null, ${explicit}`],
      ["computed duplicate key", `${name}: null, ["${name}"]: ${value}`],
      ["earlier spread", `...options, ${explicit}`],
      ["earlier computed identifier", `[key]: null, ${explicit}`],
      ["earlier computed expression", `[getKey()]: null, ${explicit}`],
      ["earlier getter", `${getter}, ${explicit}`],
      ["earlier method", `${method}, ${explicit}`],
      ["unrelated later key", `${explicit}, title: "title"`],
      ["unrelated computed literal", `${explicit}, ["title"]: null`],
      ["unrelated numeric key", `${explicit}, [1]: null`],
      ["unrelated empty key", `${explicit}, [""]: null`],
      ["unrelated getter", `${explicit}, get title() { return "title"; }`],
    ];

    it.each(explicitCases)(
      "retains the explicit value with %s",
      (_, members) => {
        const analysis = analyzeOption(name, `{ ${members} }`);
        expect(analysis.parse_status).toBe("complete");
        if (name === "webPreferences") {
          expect(analysis.electron.browser_windows).toEqual([
            expect.objectContaining({
              options_status: "object-literal",
              web_preferences_status: "object-literal",
              preload_path: "./kept.js",
              preload_resolution_context: "module-specifier",
              web_preferences: [
                { name: "preload", value: literal("./kept.js") },
                { name: "sandbox", value: literal(true) },
              ],
            }),
          ]);
        } else {
          expect(analysis.electron.utility_processes).toEqual([
            expect.objectContaining({ service_name: "kept" }),
          ]);
        }
      },
    );

    const dynamicCases = [
      ["same-spelled computed binding", `[${name}]: ${value}`],
      ["different computed binding", `[key]: ${value}`],
      ["computed expression", `[getKey()]: ${value}`],
      ["unevaluated template key", `[\`${name}\`]: ${value}`],
      ["spread only", "...options"],
      ["later spread", `${explicit}, ...options`],
      ["later computed binding", `${explicit}, [key]: null`],
      ["later computed expression", `${explicit}, [getKey()]: null`],
      ["exact getter", getter],
      ["exact setter", setter],
      ["exact method", method],
      ["computed string method", `["${name}"]() { return ${value}; }`],
      ["overriding getter", `${explicit}, ${getter}`],
      ["overriding setter", `${explicit}, ${setter}`],
      ["overriding method", `${explicit}, ${method}`],
      ["dynamic explicit value", `${name}: dynamicValue`],
      ["null explicit value", `${name}: null`],
      ["duplicate null value", `${explicit}, ${name}: null`],
    ];

    it.each(dynamicCases)("preserves uncertainty for %s", (_, members) => {
      expectUnknownOption(name, `{ ${members} }`, "object-literal");
    });

    it.each(["null", "options"])(
      "preserves nonliteral options %s",
      (options) => {
        expectUnknownOption(name, options, "dynamic");
      },
    );

    it.each(["", "{}", '{ title: "title", ["other"]: null }'])(
      "reports an omitted option in %s without inventing a default",
      (options) => {
        const analysis = analyzeOption(name, options);
        expect(analysis.parse_status).toBe("complete");
        if (name === "webPreferences")
          expect(analysis.electron.browser_windows[0]).toMatchObject({
            options_status: options === "" ? "missing" : "object-literal",
            web_preferences_status: "missing",
            web_preferences: [],
            preload_path: null,
            preload_resolution_context: null,
          });
        else
          expect(
            analysis.electron.utility_processes[0]?.service_name,
          ).toBeNull();
      },
    );
  },
);

type OptionName = "webPreferences" | "serviceName";

const analyzeOption = (name: OptionName, options: string) =>
  analyzeJavaScriptStaticSource(`
    const webPreferences = "title";
    const serviceName = "env";
    ${
      name === "webPreferences"
        ? `new BrowserWindow(${options});`
        : `utilityProcess.fork("./worker.js", []${options === "" ? "" : `, ${options}`});`
    }
  `);

const literal = (value: string | boolean) => ({
  status: "literal",
  value,
  expression: null,
});

const expectUnknownOption = (
  name: OptionName,
  options: string,
  optionsStatus: "object-literal" | "dynamic",
): void => {
  const analysis = analyzeOption(name, options);
  expect(analysis.parse_status).toBe("partial");
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.limitations.join(" ")).toContain("remain unknown");
  if (name === "webPreferences")
    expect(analysis.electron.browser_windows[0]).toMatchObject({
      options_status: optionsStatus,
      web_preferences_status: "dynamic",
      web_preferences: [],
      preload_path: null,
      preload_resolution_context: null,
    });
  else
    expect(analysis.electron.utility_processes[0]).toMatchObject({
      module_path: "./worker.js",
      module_expression: null,
      service_name: null,
    });
};

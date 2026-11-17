import {
  registerCliCommand,
  cliCommand,
} from "../../../src/cli/commandRegistry.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { z } from "zod";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { estimateTokenCount } from "tokenx";
import { createMarkdownRenderer, disposeMdItInstance } from "vitepress";
import { afterAll, expect, it } from "vitest";

import {
  redactCliCommandFailure,
  renderCliCommandFailure,
} from "../../../src/cli/argumentErrors.js";
import { explicitSensitiveValueOptions } from "../../../src/cli/explicitSensitiveArguments.js";

import { readCliOutputArguments } from "../../../src/cliOutput.js";
import { parseCliGlobalArguments } from "../../../src/cliBuiltinArguments.js";
import { cliTest } from "../../support/cli/cliFixture.js";

afterAll(() => disposeMdItInstance());

cliTest(
  "renders complete validation choices in a Markdown table",
  async ({ cli }) => {
    const args = [
      "search",
      "./missing-input",
      "needle",
      "--kind",
      "unrecognized",
    ];
    const markdown = await cli.run({ arguments: [...args, "--format", "md"] });
    const full = await cli.run({
      arguments: [...args, "--format", "md", "--full-output"],
    });
    const count = await cli.run({
      arguments: [...args, "--format", "md", "--token-count"],
    });
    const window = await cli.run({
      arguments: [
        ...args,
        "--format",
        "md",
        "--full-output",
        "--token-limit",
        "20",
      ],
    });
    const json = await cli.run({ arguments: [...args, "--format", "json"] });
    expect(markdown.exitCode).toBe(1);
    expect(full.exitCode).toBe(1);
    expect(count.exitCode).toBe(1);
    expect(window.exitCode).toBe(1);
    expect(json.exitCode).toBe(1);
    expect(markdown.stderr).toBe("");
    expect(json.stderr).toBe("");
    const failure = JSON.parse(json.stdout);
    expect(failure.code).toBe("VALIDATION_ERROR");
    const message = failure.fieldErrors[0].message as string;
    expect(message).toContain('"strings"|"procedures"');

    const renderer = await createMarkdownRenderer(process.cwd(), {
      linkify: false,
    });
    const visibleText = (node: DefaultTreeAdapterTypes.Node): string =>
      node.nodeName === "#text" && "value" in node
        ? node.value
        : "childNodes" in node
          ? node.childNodes.map(visibleText).join("")
          : "";
    const renderedCells = (output: string): string[] => {
      const cells: string[] = [];
      const visit = (node: DefaultTreeAdapterTypes.Node): void => {
        if ("tagName" in node && node.tagName === "td") {
          cells.push(visibleText(node));
        } else if ("childNodes" in node) node.childNodes.forEach(visit);
      };
      visit(parseFragment(renderer.render(output)));
      return cells;
    };
    expect(renderedCells(markdown.stdout)).toContain(message);
    expect(renderedCells(full.stdout)).toContain(message);
    expect(Number(count.stdout.trim())).toBe(
      estimateTokenCount(markdown.stdout.trimEnd()),
    );
    expect(
      visibleText(parseFragment(renderer.render(window.stdout))),
    ).toContain("[truncated: showing tokens 0–20 of ");
    expect(window.stdout).toContain("nextOffset");

    // A different parser error has a much longer enum. Compare the visible
    // cell with the unmodified machine-readable diagnostic, not a subset.
    const doctorArgs = ["doctor", "--client", "x|y"];
    const doctorMd = await cli.run({
      arguments: [...doctorArgs, "--format", "md"],
    });
    const doctorJson = await cli.run({
      arguments: [...doctorArgs, "--format", "json"],
    });
    expect(doctorMd.exitCode).toBe(1);
    expect(doctorJson.exitCode).toBe(1);
    const doctorMessage = JSON.parse(doctorJson.stdout).fieldErrors[0]
      .message as string;
    expect(doctorMessage.split("|").length).toBeGreaterThan(2);
    expect(renderedCells(doctorMd.stdout)).toContain(doctorMessage);
  },
);

cliTest(
  "redacts a pipe-containing declaration before Markdown encoding",
  async ({ cli }) => {
    const secret = '"har"|"mitmproxy"';
    const args = [
      "inspect-web-network-capture",
      "/nonexistent/capture.har",
      "bogus",
    ];
    const run = (format: string, declared: boolean) =>
      cli.run({
        arguments: [
          ...args,
          ...(declared ? ["--sensitive-value", secret] : []),
          "--format",
          format,
        ],
      });
    const markdown = await run("md", true);
    const json = await run("json", true);
    const control = await run("json", false);
    expect(markdown.exitCode).toBe(1);
    expect(json.exitCode).toBe(1);
    expect(markdown.stderr).toBe("");
    expect(json.stderr).toBe("");
    expect(markdown.stdout).not.toContain('"har"\\|"mitmproxy"');
    const renderer = await createMarkdownRenderer(process.cwd(), {
      linkify: false,
    });
    const rendered = renderer.render(markdown.stdout);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("[REDACTED]");
    const message = JSON.parse(json.stdout).fieldErrors[0].message as string;
    expect(message).not.toContain(secret);
    expect(message).toContain("[REDACTED]");
    expect(JSON.parse(control.stdout).fieldErrors[0].message).toContain(secret);
  },
);

// Exercise literal field facts at the presentation boundary; shipped schemas
// cannot manufacture all punctuation/whitespace combinations as issue fields.
const fixtureDiagnostic = (
  value: string,
  secret: string,
  format: string,
  sensitive: boolean,
): string => {
  const cli = createCommandCli();
  registerCliCommand(cli, "inspect", {
    options: z.object({ ...explicitSensitiveValueOptions }),
    run: () => undefined,
  });
  const entry = cliCommand(cli, "inspect")!;
  return renderCliCommandFailure(
    redactCliCommandFailure(
      {
        code: "VALIDATION_ERROR",
        message: "fixture",
        fieldErrors: [
          {
            code: "invalid_value",
            missing: false,
            path: "input",
            expected: "",
            received: value,
            message: `Value ${value} is invalid`,
          },
        ],
      },
      sensitive ? [secret] : [],
    ),
    {
      cli: cli.name,
      entry,
      duration: "0ms",
      stdoutIsTerminal: false,
      controls: readCliOutputArguments(
        parseCliGlobalArguments(["--format", format]),
      ),
    },
  );
};

it("redacts Markdown punctuation in validation fields before presentation", async () => {
  for (const secret of [
    "left|right",
    "*markup*",
    "left\\right",
    "<tag>&value",
  ]) {
    const run = (format: string, sensitive: boolean) =>
      fixtureDiagnostic(secret, secret, format, sensitive);
    const md = await run("md", true);
    const json = JSON.parse(await run("json", true));
    const control = JSON.parse(await run("json", false));
    const renderer = await createMarkdownRenderer(process.cwd(), {
      linkify: false,
    });
    expect(md).not.toContain(secret);
    expect(renderer.render(md)).not.toContain(secret);
    expect(renderer.render(md)).toContain("[REDACTED]");
    expect(json.fieldErrors[0].received).toBe("[REDACTED]");
    expect(json.fieldErrors[0].message).toBe("Value [REDACTED] is invalid");
    expect(control.fieldErrors[0].received).toBe(secret);
    expect(control.fieldErrors[0].message).toBe(`Value ${secret} is invalid`);
  }
});

it("retains upstream Markdown literal-cell protections after redaction", async () => {
  const value = "\u00a0\t:smile: secret|token # {x}\t\u202f";
  const secret = "secret|token";
  const run = (format: string, sensitive: boolean) =>
    fixtureDiagnostic(value, secret, format, sensitive);
  const md = await run("md", false);
  const redactedMd = await run("md", true);
  const json = JSON.parse(await run("json", false));
  const redactedJson = JSON.parse(await run("json", true));
  expect(md).toContain("&#160;&#9;");
  expect(md).toContain("&#9;&#8239;");
  expect(md).toContain("&#58;smile&#58;");
  expect(md).toContain("secret\\|token");
  expect(redactedMd).not.toContain("secret\\|token");
  const renderer = await createMarkdownRenderer(process.cwd(), {
    linkify: false,
  });
  const text = (node: DefaultTreeAdapterTypes.Node): string =>
    node.nodeName === "#text" && "value" in node
      ? node.value
      : "childNodes" in node
        ? node.childNodes.map(text).join("")
        : "";
  const rendered = text(parseFragment(renderer.render(md)));
  const redactedRendered = text(parseFragment(renderer.render(redactedMd)));
  expect(rendered).toContain(value);
  expect(redactedRendered).not.toContain(secret);
  expect(redactedRendered).toContain("[REDACTED]");
  expect(json.fieldErrors[0].received).toBe(value);
  expect(redactedJson.fieldErrors[0].received).toBe(
    value.replace(secret, "[REDACTED]"),
  );
});

import { Cli, Errors, z } from "incur";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { estimateTokenCount } from "tokenx";
import { createMarkdownRenderer, disposeMdItInstance } from "vitepress";
import { afterAll, expect, it } from "vitest";

import {
  encodeCliArgumentErrors,
  presentCliArgumentErrors,
} from "../../../src/cli/argumentErrors.js";
import {
  excludeDeclaredSensitiveArguments,
  explicitSensitiveValueOptions,
} from "../../../src/cli/explicitSensitiveArguments.js";

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
    const renderedCells = (output: string): string[] => {
      const cells: string[] = [];
      const visit = (node: DefaultTreeAdapterTypes.Node): void => {
        if ("tagName" in node && node.tagName === "td") {
          const text = (child: DefaultTreeAdapterTypes.Node): string =>
            child.nodeName === "#text" && "value" in child
              ? child.value
              : "childNodes" in child
                ? child.childNodes.map(text).join("")
                : "";
          cells.push(text(node));
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
    expect(window.stdout).toContain("[truncated: showing tokens 0–20 of ");
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

it("redacts Markdown punctuation in validation fields before presentation", async () => {
  for (const secret of [
    "left|right",
    "*markup*",
    "left\\right",
    "<tag>&value",
  ]) {
    const cli = Cli.create("sensitive-fixture", { sync: false });
    cli.command("inspect", {
      options: z.object({ ...explicitSensitiveValueOptions }),
      run: () => {
        throw new Errors.ValidationError({
          message: "fixture",
          fieldErrors: [
            {
              code: "invalid_value",
              missing: false,
              path: "input",
              expected: "",
              received: secret,
              message: `Value ${secret} is invalid`,
            },
          ],
        });
      },
    });
    presentCliArgumentErrors(cli);
    const declared = excludeDeclaredSensitiveArguments(cli);
    encodeCliArgumentErrors(cli);
    const original = cli.serve.bind(cli);
    const run = async (format: string, sensitive: boolean) => {
      let stdout = "";
      let exitCode = 0;
      await declared(
        [
          "inspect",
          ...(sensitive ? ["--sensitive-value", secret] : []),
          "--format",
          format,
        ],
        {
          env: {},
          stdout: (text) => {
            stdout += text;
          },
          exit: (code) => {
            exitCode = code;
          },
        },
        original,
      );
      expect(exitCode).toBe(1);
      return stdout;
    };
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
  const value = "\t:smile: secret|token # {x}\t";
  const secret = "secret|token";
  const cli = Cli.create("literal-validation-fixture", { sync: false });
  cli.command("inspect", {
    options: z.object({ ...explicitSensitiveValueOptions }),
    run: () => {
      throw new Errors.ValidationError({
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
      });
    },
  });
  presentCliArgumentErrors(cli);
  const declared = excludeDeclaredSensitiveArguments(cli);
  encodeCliArgumentErrors(cli);
  const original = cli.serve.bind(cli);
  const run = async (format: string, sensitive: boolean) => {
    let stdout = "";
    let exitCode = 0;
    await declared(
      [
        "inspect",
        ...(sensitive ? ["--sensitive-value", secret] : []),
        "--format",
        format,
      ],
      {
        env: {},
        stdout: (text) => {
          stdout += text;
        },
        exit: (code) => {
          exitCode = code;
        },
      },
      original,
    );
    expect(exitCode).toBe(1);
    return stdout;
  };
  const md = await run("md", false);
  const redactedMd = await run("md", true);
  const json = JSON.parse(await run("json", false));
  const redactedJson = JSON.parse(await run("json", true));
  expect(md).toContain("&#9;");
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

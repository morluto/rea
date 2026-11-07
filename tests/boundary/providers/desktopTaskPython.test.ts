import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import { evaluateTaskChecks } from "../../../src/domain/desktop/appTaskChecks.js";
import {
  CHECK_CASES,
  CHECK_VIEWS,
} from "../../../src/domain/desktop/appTaskChecks.fixture.js";
import { renderTaskVerifier } from "../../../src/domain/desktop/appTaskPython.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** The protocol client calls the verifier makes, replaced so it reads the given views. */
const STUB_CLIENT = `
def find_child(card, name):
    return next((child for child in card.get("children_environments") or [] if child.get("name") == name), None)
`;

const DRIVER = String.raw`
import asyncio, importlib.util, json, sys
folder, verifier = sys.argv[1], sys.argv[2]
sys.path.insert(0, folder)
from agentenv_protocol import client

views, called = json.load(sys.stdin), []


class Part:
    kind = "data"
    data = {"state": views}


class Answer:
    parts = [Part]


async def get_card(url, **_):
    called.append(url)
    return {"name": "computer", "children_environments": [{"name": "notes", "url": "/svc/notes/agentenv"}]}


async def get_data(url, **_):
    called.append(url)
    return Answer


client.get_card, client.get_data = get_card, get_data
spec = importlib.util.spec_from_file_location("verifier", verifier)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({"called": called, "results": asyncio.run(module.verify("http://mcp", "http://computer:8080"))}))
`;

it("evaluates every kind of check in the exported verifier as REA does", async () => {
  const folder = await createTestTempDirectory("desktop-task-python-");
  await mkdir(join(folder, "agentenv_protocol"));
  await writeFile(join(folder, "agentenv_protocol/__init__.py"), "");
  await writeFile(join(folder, "agentenv_protocol/client.py"), STUB_CLIENT);
  await writeFile(
    join(folder, "agentenv_protocol/types.py"),
    'RPC_PATH = "/agentenv"\n',
  );
  const checks: DesktopTaskCheck[] = CHECK_CASES.map(([check], index) => ({
    ...check,
    id: `check-${String(index + 1)}`,
  }));
  const verifier = join(folder, "verify.py");
  await writeFile(
    verifier,
    renderTaskVerifier(
      { name: "edit-notes", prompt: "Edit.", checks },
      "notes",
    ),
  );

  const output = JSON.parse(
    execFileSync("python3", ["-I", "-B", "-c", DRIVER, folder, verifier], {
      input: JSON.stringify(CHECK_VIEWS),
      encoding: "utf8",
    }),
  ) as {
    called: string[];
    results: { id: string; result: boolean; description: string }[];
  };

  expect(output.called).toEqual([
    "http://computer:8080",
    "http://computer:8080/svc/notes",
  ]);
  const typescript = evaluateTaskChecks(
    checks,
    new Map(Object.entries(CHECK_VIEWS)),
  );
  expect(output.results.map(({ id, result }) => [id, result])).toEqual(
    typescript.map(({ id, passed }) => [id, passed]),
  );
  expect(output.results.map(({ result }) => result)).toEqual(
    CHECK_CASES.map(([, expected]) => expected),
  );
  expect(output.results.map(({ description }) => description)).toEqual(
    typescript.map(({ description }) => description),
  );
});

import { expectTypeOf, it } from "vitest";

import type { CdpConnection } from "../CdpConnection.js";
import type { PlaywrightCdpSession } from "../PlaywrightCdpSession.js";
import type {
  CdpCommand,
  CdpCommandResult,
  CdpDomainWith,
} from "./CdpCommands.js";

// `npm run typecheck` compiles this file. A `@ts-expect-error` whose line
// starts to compile fails the typecheck, so these are negative compile tests.

// A protocol command REA has not registered a result schema for.
type UnregisteredCommand = "Accessibility.getPartialAXTree";

it("sends only commands with a registered result schema", () => {
  expectTypeOf<"Runtime.enable">().toExtend<CdpCommand>();
  expectTypeOf<UnregisteredCommand>().not.toExtend<CdpCommand>();

  const send = (method: UnregisteredCommand, connection: CdpConnection) =>
    // @ts-expect-error An unregistered command name does not compile.
    connection.send(method);
  expectTypeOf(send).toBeFunction();

  // Playwright sessions are opened only through this owner (`rea/no-raw-cdp-session`).
  const sendPlaywright = (
    method: UnregisteredCommand,
    session: PlaywrightCdpSession,
  ) =>
    // @ts-expect-error An unregistered command name does not compile.
    session.send(method);
  expectTypeOf(sendPlaywright).toBeFunction();
});

it("builds run-time command names only from registered domains", () => {
  expectTypeOf<"Runtime">().toExtend<CdpDomainWith<"enable">>();
  expectTypeOf<"Accessibility">().not.toExtend<CdpDomainWith<"enable">>();
  expectTypeOf<"Accessibility">().not.toExtend<CdpDomainWith<"disable">>();
});

it("resolves a send to the command's parsed result", () => {
  const getTargets = (connection: CdpConnection) =>
    connection.send("Target.getTargets");
  expectTypeOf<Awaited<ReturnType<typeof getTargets>>>().toEqualTypeOf<
    CdpCommandResult<"Target.getTargets">
  >();
  expectTypeOf<CdpCommandResult<"Target.getTargets">>().toEqualTypeOf<{
    targetInfos: unknown[];
  }>();
});

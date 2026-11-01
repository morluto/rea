import { expect, it, onTestFinished } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisExecution,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisTimeoutError,
} from "../../../src/domain/analysisErrorCore.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import {
  inferredUnavailabilityReason,
  runtimeFailureReason,
} from "../../../src/application/binary/SessionRuntimeAvailability.js";
import {
  EXISTING_PROJECT_READ_ONLY,
  EXISTING_PROJECT_READ_ONLY_REMEDIATION,
} from "../../../src/ghidra/GhidraProviderCapabilities.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok, type Result } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

it("restores MCP tool availability after cancelling a target switch", async () => {
  const [first, second] = await createBinarySessionTargets();
  const closing = createDeferred<void>();
  const release = createDeferred<void>();
  const cancellationObserved = createDeferred<void>();
  const provider = createCacheProvider([]);
  const resolveProfile = provider.resolveAnalysisProfile;
  if (resolveProfile === undefined)
    throw new Error("Missing test analysis profile");
  const clients: { calls: number; closed: number }[] = [];
  provider.createClient = () => {
    const state = { calls: 0, closed: 0 };
    const firstClient = clients.length === 0;
    clients.push(state);
    return {
      execute: (operation) => {
        state.calls += 1;
        return Promise.resolve(
          firstClient
            ? err(new ProviderAdapterError("fixture", operation))
            : observed("restored-name"),
        );
      },
      close: async () => {
        state.closed += 1;
        if (firstClient) {
          closing.resolve();
          await release.promise;
        }
        return ok(null);
      },
    };
  };
  const session = createTestBinarySession(provider, {
    resolveAnalysisProfile: (target, options) => {
      if (target.path === second) {
        options?.signal?.addEventListener(
          "abort",
          () => cancellationObserved.resolve(),
          { once: true },
        );
      }
      return resolveProfile(target, options);
    },
  });
  const { client, close } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "session-recovery", version: "1" },
    serverOptions: { environment: {}, logger: silentLogger },
  });
  const controller = new AbortController();
  const readStatus = async () => {
    const reply = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    return toolContract("binary_session").outputSchema.parse(
      reply.structuredContent,
    ).result;
  };
  try {
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: first },
    });
    expect(opened.isError).not.toBe(true);
    const query = { address: "0x1000", document: "fixture" };
    expect(
      (await client.callTool({ name: "address_name", arguments: query }))
        .isError,
    ).toBe(true);
    const before = await readStatus();
    expect(
      expandToolAvailability(before.tool_availability).find(
        (tool) => tool.name === "address_name",
      ),
    ).toMatchObject({
      available: false,
      reason: "provider_unavailable",
    });

    const switching = client.callTool(
      { name: "open_binary", arguments: { path: second } },
      { signal: controller.signal },
    );
    const cancelled = expect(switching).rejects.toThrow();
    await closing.promise;
    controller.abort();
    await cancellationObserved.promise;
    release.resolve();
    await cancelled;

    // Cancellation ends the client's wait before the server restores its session.
    const settled = await session.withAdmittedAnalysis(
      "binary_session",
      undefined,
      async () => null,
    );
    if (!settled.ok) throw settled.error;
    const restored = await readStatus();
    expect(restored).toMatchObject({ open: true, path: first });
    expect(before.analysis_run?.run_id).toEqual(expect.any(String));
    expect(restored.analysis_run?.run_id).toEqual(expect.any(String));
    expect(restored.analysis_run?.run_id).not.toBe(before.analysis_run?.run_id);
    expect(clients).toEqual([{ calls: 1, closed: 1 }]);
    expect(
      expandToolAvailability(restored.tool_availability).find(
        (tool) => tool.name === "address_name",
      ),
    ).toMatchObject({
      available: true,
      reason: "available",
      remediation: null,
    });

    const retried = await client.callTool({
      name: "address_name",
      arguments: query,
    });
    expect(retried.isError).not.toBe(true);
    expect(retried.structuredContent).toMatchObject({
      normalized_result: "restored-name",
    });
    expect(clients).toEqual([
      { calls: 1, closed: 1 },
      { calls: 1, closed: 0 },
    ]);
  } finally {
    controller.abort();
    release.resolve();
    await close();
  }
});

it("keeps a retired run and its lineage visible over MCP until cleanup succeeds", async () => {
  const [path] = await createBinarySessionTargets();
  let allowed = false;
  const provider = createCacheProvider([]);
  provider.createClient = (_target, _profile, context) => {
    if (context === undefined) throw new Error("missing analysis run context");
    return {
      execute: () => Promise.resolve(observed("fixture-name")),
      runtimeLineageSnapshots: () => [
        {
          provider: provider.identity(),
          observation: {
            status: "unavailable" as const,
            observedAt: "2026-10-16T00:00:00Z",
            runId: context.runId,
            launcherPid: 123,
            processGroupId: 123,
            reason: "fixture identity could not be revalidated",
          },
        },
      ],
      close: () =>
        Promise.resolve(
          allowed
            ? ok(null)
            : err(
                new ProviderCleanupError("fixture", ["owned-runtime"], {
                  reason: "fixture cleanup denied",
                }),
              ),
        ),
    };
  };
  const session = createTestBinarySession(provider);
  const { client, close } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "retained-run", version: "1" },
    serverOptions: { environment: {}, logger: silentLogger },
  });
  const readStatus = async () => {
    const reply = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    return toolContract("binary_session").outputSchema.parse(
      reply.structuredContent,
    ).result;
  };
  try {
    expect((await readStatus()).analysis_run).toBeNull();
    expect(
      (await client.callTool({ name: "open_binary", arguments: { path } }))
        .isError,
    ).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: "address_name",
          arguments: { address: "0x1000", document: "fixture" },
        })
      ).isError,
    ).not.toBe(true);
    const before = await readStatus();
    expect(before.analysis_run).toMatchObject({
      run_id: expect.any(String),
      process_lineage: { status: "snapshots" },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (await client.callTool({ name: "close_binary", arguments: {} }))
          .isError,
      ).toBe(true);
      expect(await readStatus()).toMatchObject({
        open: false,
        cleanup_pending: true,
        analysis_run: before.analysis_run,
      });
    }
    allowed = true;
    expect(
      (await client.callTool({ name: "close_binary", arguments: {} })).isError,
    ).not.toBe(true);
    expect(await readStatus()).toMatchObject({
      open: false,
      cleanup_pending: false,
      analysis_run: null,
    });
  } finally {
    allowed = true;
    await close();
  }
});

it("keeps provider tools available after one request reaches its deadline", async () => {
  const [path] = await createBinarySessionTargets();
  const provider = createCacheProvider([]);
  let calls = 0;
  provider.createClient = () => ({
    execute: (operation) => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? err(
              new AnalysisTimeoutError(operation, 5000, {
                userMessage:
                  "Fixture decompilation exceeded its 5-second limit. The session remains usable.",
              }),
            )
          : observed("after-timeout"),
      );
    },
    close: () => Promise.resolve(ok(null)),
  });
  const session = createTestBinarySession(provider);
  const { client, close } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "request-timeout", version: "1" },
    serverOptions: { environment: {}, logger: silentLogger },
  });
  const availability = async () => {
    const reply = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    return expandToolAvailability(
      toolContract("binary_session").outputSchema.parse(reply.structuredContent)
        .result.tool_availability,
    );
  };
  try {
    expect(
      (await client.callTool({ name: "open_binary", arguments: { path } }))
        .isError,
    ).not.toBe(true);
    const before = await availability();
    const query = { address: "0x1000", document: "fixture" };
    const timedOut = await client.callTool({
      name: "address_name",
      arguments: query,
    });
    expect(timedOut.isError).toBe(true);
    expect(parseMcpToolError(timedOut)).toMatchObject({
      error: { code: "provider_timeout", retryable: true },
    });
    // A request-level deadline is not a provider failure: nothing is marked
    // unavailable, unlike the ProviderAdapterError case above.
    expect(await availability()).toEqual(before);
    const retried = await client.callTool({
      name: "address_name",
      arguments: query,
    });
    expect(retried.structuredContent).toMatchObject({
      normalized_result: "after-timeout",
    });
  } finally {
    await close();
  }
});

type Reply = Result<AnalysisExecution, AnalysisError>;
type Responder = (operation: string) => Promise<Reply>;

const FIXTURE = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
} as const satisfies ProviderIdentity;
const AUXILIARY = {
  id: "fixture-auxiliary",
  name: "Auxiliary fixture provider",
  version: "1",
} as const satisfies ProviderIdentity;

const liveCapability = (
  provider: ProviderIdentity,
  operation: Exclude<AnalysisOperation, "health">,
  declaredRefusal?: string,
): CapabilityDescriptor => ({
  provider,
  operation,
  ...(declaredRefusal === undefined
    ? { available: true as const, reason: null }
    : { available: false as const, reason: declaredRefusal }),
  cachePolicy: "live",
  effects: {
    mutatesArtifact: false,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const adapterFailure = (provider: ProviderIdentity, operation: string) =>
  Promise.resolve(err(new ProviderAdapterError(provider.id, operation)));
const recordedReason = (failure: AnalysisError): string => {
  const reason = runtimeFailureReason(failure);
  if (reason === undefined) throw new Error(`${failure._tag} is not recorded`);
  return reason;
};
// Compare remediation with its owning formatters; the facts are their inputs.
const observedFailure = (operation: string, provider: string = FIXTURE.id) =>
  recordedReason(new ProviderAdapterError(provider, operation));
const inferredFailure = (operation: string, provider: string = FIXTURE.id) =>
  inferredUnavailabilityReason(provider, {
    operation,
    reason: observedFailure(operation, provider),
  });
const refusal = (operation: string, reason: string) =>
  recordedReason(
    new AnalysisCapabilityUnavailableError(FIXTURE.id, operation, reason),
  );

/** Hold provider replies; release and join every launched call. */
const heldCalls = (
  client: Awaited<ReturnType<typeof createApplicationMcpHarness>>["client"],
) => {
  const held = new Map<
    string,
    { readonly reply: Promise<Reply>; readonly received: () => void }
  >();
  const launched: {
    readonly release: (reply: Reply) => void;
    readonly response: Promise<unknown>;
  }[] = [];
  return {
    /** Serve a held reply when one is registered for this operation. */
    respond: (operation: string): Promise<Reply> | undefined => {
      const entry = held.get(operation);
      if (entry === undefined) return undefined;
      held.delete(operation);
      entry.received();
      return entry.reply;
    },
    dispatch: async (name: string, arguments_: Record<string, unknown>) => {
      const reply = createDeferred<Reply>();
      const received = createDeferred<void>();
      held.set(name, { reply: reply.promise, received: received.resolve });
      const response = client.callTool({ name, arguments: arguments_ });
      launched.push({ release: reply.resolve, response });
      await awaitAcknowledgement(received.promise, response, name);
      return {
        release: reply.resolve,
        isError: async () => (await response).isError === true,
      };
    },
    /** Release every held reply and wait for its MCP response. */
    join: async () => {
      for (const { release } of launched) release(observed("released"));
      await Promise.allSettled(launched.map(({ response }) => response));
    },
  };
};

/** Connect a deep fixture and an auxiliary provider with scripted replies. */
const connectScripted = async (options: {
  readonly operations: readonly Exclude<AnalysisOperation, "health">[];
  readonly auxiliaryOperations?: readonly Exclude<
    AnalysisOperation,
    "health"
  >[];
  readonly respond: { current: Responder };
  readonly respondAuxiliary?: { current: Responder };
  /** Operations the fixture declares unavailable, with their declared reason. */
  readonly declaredRefusals?: Readonly<Record<string, string>>;
  readonly declaredRemediation?: Readonly<Record<string, string>>;
  readonly families?: string;
}) => {
  const [path] = await createBinarySessionTargets();
  const provider: AnalysisProvider = {
    identity: () => FIXTURE,
    resolveAnalysisProfile: () =>
      Promise.resolve(
        ok({ profile: createAnalysisProfile(FIXTURE, { fixture: true }) }),
      ),
    capabilities: () =>
      options.operations.map((operation) => {
        const descriptor = liveCapability(
          FIXTURE,
          operation,
          options.declaredRefusals?.[operation],
        );
        const remediation = options.declaredRemediation?.[operation];
        return descriptor.available || remediation === undefined
          ? descriptor
          : { ...descriptor, remediation };
      }),
    createClient: () => ({
      execute: (operation) =>
        operation === "health"
          ? Promise.resolve(observed(null))
          : options.respond.current(operation),
      close: () => Promise.resolve(ok(null)),
    }),
  };
  const auxiliary: AnalysisProvider = {
    identity: () => AUXILIARY,
    capabilities: () =>
      (options.auxiliaryOperations ?? []).map((operation) =>
        liveCapability(AUXILIARY, operation),
      ),
    createClient: () => ({
      execute: (operation) =>
        options.respondAuxiliary?.current(operation) ??
        Promise.resolve(ok(createAnalysisExecution(null, AUXILIARY))),
      close: () => Promise.resolve(ok(null)),
    }),
  };
  const session = createTestBinarySession(provider, {
    auxiliaryProviders: [auxiliary],
  });
  const { client, close } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "provider-recovery", version: "1" },
    serverOptions: {
      environment:
        options.families === undefined
          ? {}
          : { REA_MCP_TOOL_FAMILIES: options.families },
      logger: silentLogger,
    },
  });
  onTestFinished(close);
  expect(
    (await client.callTool({ name: "open_binary", arguments: { path } }))
      .isError,
  ).not.toBe(true);
  const call = async (name: string, arguments_: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: arguments_ })).isError === true
      ? "error"
      : "ok";
  const tools = async () => {
    const reply = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    return expandToolAvailability(
      toolContract("binary_session").outputSchema.parse(reply.structuredContent)
        .result.tool_availability,
    );
  };
  const availability = async (names: readonly string[]) => {
    const advertised = await tools();
    return Object.fromEntries(
      names.map((name) => {
        const tool = advertised.find((entry) => entry.name === name);
        if (tool === undefined) throw new Error(`${name} is not advertised`);
        return [name, tool.available ? "available" : tool.remediation];
      }),
    );
  };
  return { client, call, availability, tools };
};

const DIRECT_OPERATIONS = [
  "address_name",
  "current_address",
  "list_procedures",
  "procedure_assembly",
  "procedure_info",
] as const;
const ADDRESS = { address: "0x1000", document: "fixture" };
const PROCEDURE = { procedure: "main" };

it("delivers a declared read-only recovery without changing the selected session", async () => {
  const calls: string[] = [];
  const { client } = await connectScripted({
    operations: ["address_name", "set_address_name"],
    declaredRefusals: { set_address_name: EXISTING_PROJECT_READ_ONLY },
    declaredRemediation: {
      set_address_name: EXISTING_PROJECT_READ_ONLY_REMEDIATION,
    },
    respond: {
      current: (operation) => {
        calls.push(operation);
        return Promise.resolve(observed("original"));
      },
    },
  });
  const before = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  const refused = await client.callTool({
    name: "set_address_name",
    arguments: { address: "0x1000", name: "new_name" },
  });
  const error = parseMcpToolError(refused).error;
  expect(error.code).toBe("capability_unavailable");
  expect(error.details?.reason).toBe(EXISTING_PROJECT_READ_ONLY);
  expect(error.message).toBe(EXISTING_PROJECT_READ_ONLY);
  expect(error.remediation.action).toBe(EXISTING_PROJECT_READ_ONLY_REMEDIATION);
  expect(error.remediation.action).toContain("REA_GHIDRA_PROJECT_PATH");
  expect(error.remediation.action).toContain("REA_GHIDRA_PROGRAM_NAME");
  expect(calls).not.toContain("set_address_name");
  const after = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  const state = (reply: typeof before) =>
    toolContract("binary_session").outputSchema.parse(reply.structuredContent)
      .result.analysis_run;
  expect(state(before)).toBeDefined();
  expect(state(after)).toEqual(state(before));
});

it("returns provider-inferred siblings to declared availability after one success", async () => {
  let broken = false;
  const respond = {
    current: (operation: string): Promise<Reply> => {
      if (operation === "procedure_info")
        return Promise.resolve(
          err(
            new AnalysisCapabilityUnavailableError(
              FIXTURE.id,
              operation,
              "fixture project is read-only",
            ),
          ),
        );
      if (broken) return adapterFailure(FIXTURE, operation);
      return Promise.resolve(observed("fixture-text"));
    },
  };
  const declared = "Fixture project was opened read-only.";
  const { call, availability } = await connectScripted({
    operations: [...DIRECT_OPERATIONS, "set_comment"],
    auxiliaryOperations: ["list_documents"],
    declaredRefusals: { set_comment: declared },
    respond,
  });
  const refused = refusal("procedure_info", "fixture project is read-only");
  expect(await call("procedure_info", PROCEDURE)).toBe("error");
  broken = true;
  expect(await call("address_name", ADDRESS)).toBe("error");
  expect(await call("procedure_assembly", PROCEDURE)).toBe("error");
  const names = [...DIRECT_OPERATIONS, "set_comment", "list_documents"];
  expect(await availability(names)).toEqual({
    address_name: observedFailure("address_name"),
    current_address: inferredFailure("procedure_assembly"),
    list_procedures: inferredFailure("procedure_assembly"),
    procedure_assembly: observedFailure("procedure_assembly"),
    // Separately observed and declared refusals keep their own reasons.
    procedure_info: refused,
    set_comment: declared,
    list_documents: "available",
  });

  broken = false;
  expect(await call("address_name", ADDRESS)).toBe("ok");
  // One success is evidence the provider answers again, not that every
  // operation is healthy: failures observed on other operations remain.
  expect(await availability(names)).toEqual({
    address_name: "available",
    current_address: "available",
    list_procedures: "available",
    procedure_assembly: observedFailure("procedure_assembly"),
    procedure_info: refused,
    set_comment: declared,
    list_documents: "available",
  });
  expect(await call("procedure_assembly", PROCEDURE)).toBe("ok");
  expect(await availability(["procedure_assembly", "procedure_info"])).toEqual({
    procedure_assembly: "available",
    procedure_info: refused,
  });
});

it("keeps each provider's failures and ignores cancelled requests", async () => {
  let fixtureBroken = false;
  let auxiliaryBroken = true;
  const respond = {
    current: (operation: string): Promise<Reply> => {
      if (operation === "list_procedures")
        return Promise.resolve(err(new AnalysisCancelledError(operation)));
      return fixtureBroken
        ? adapterFailure(FIXTURE, operation)
        : Promise.resolve(observed("fixture-text"));
    },
  };
  const respondAuxiliary = {
    current: (operation: string): Promise<Reply> =>
      auxiliaryBroken
        ? adapterFailure(AUXILIARY, operation)
        : Promise.resolve(ok(createAnalysisExecution("doc", AUXILIARY))),
  };
  const { call, availability } = await connectScripted({
    operations: ["address_name", "current_address", "list_procedures"],
    auxiliaryOperations: ["current_document", "list_documents"],
    respond,
    respondAuxiliary,
  });
  const names = [
    "address_name",
    "current_address",
    "list_procedures",
    "current_document",
    "list_documents",
  ];
  expect(await call("list_documents", {})).toBe("error");
  expect(await call("address_name", ADDRESS)).toBe("ok");
  const auxiliaryFailure = {
    current_document: inferredFailure("list_documents", AUXILIARY.id),
    list_documents: observedFailure("list_documents", AUXILIARY.id),
  };
  // Another provider's success does not clear the auxiliary provider's state.
  expect(await availability(names)).toEqual({
    address_name: "available",
    current_address: "available",
    list_procedures: "available",
    ...auxiliaryFailure,
  });

  fixtureBroken = true;
  expect(await call("address_name", ADDRESS)).toBe("error");
  // A cancelled request is not evidence that the provider recovered.
  expect(await call("list_procedures", {})).toBe("error");
  const fixtureFailure = {
    address_name: observedFailure("address_name"),
    current_address: inferredFailure("address_name"),
    list_procedures: inferredFailure("address_name"),
  };
  expect(await availability(names)).toEqual({
    ...fixtureFailure,
    ...auxiliaryFailure,
  });

  auxiliaryBroken = false;
  expect(await call("current_document", {})).toBe("ok");
  expect(await availability(names)).toEqual({
    ...fixtureFailure,
    current_document: "available",
    list_documents: auxiliaryFailure.list_documents,
  });
});

it("keeps newer failures when older successes complete after them", async () => {
  let reply: Responder = () => Promise.resolve(observed("text"));
  const respond = { current: (operation: string) => reply(operation) };
  const { client, call, availability } = await connectScripted({
    operations: [...DIRECT_OPERATIONS, "current_procedure"],
    respond,
  });
  const calls = heldCalls(client);
  respond.current = (operation) => calls.respond(operation) ?? reply(operation);
  const document = { document: "doc" };
  const refuse: Responder = (operation) =>
    Promise.resolve(
      err(
        new AnalysisCapabilityUnavailableError(
          FIXTURE.id,
          operation,
          "fixture refusal",
        ),
      ),
    );
  try {
    // Successes dispatched before an own refusal, before a provider failure,
    // or between the two complete after both.
    const olderAddress = await calls.dispatch("address_name", ADDRESS);
    const olderCurrent = await calls.dispatch("current_address", document);
    reply = refuse;
    expect(await call("address_name", ADDRESS)).toBe("error");
    expect(await call("current_procedure", document)).toBe("error");
    const between = await calls.dispatch("current_procedure", document);
    reply = (operation) => adapterFailure(FIXTURE, operation);
    expect(await call("procedure_assembly", PROCEDURE)).toBe("error");
    olderAddress.release(observed("old-name"));
    olderCurrent.release(observed("0x1000"));
    between.release(observed("main"));
    for (const settled of [olderAddress, olderCurrent, between])
      expect(await settled.isError()).toBe(false);
    expect(
      await availability([
        "address_name",
        "current_address",
        "current_procedure",
        "list_procedures",
      ]),
    ).toEqual({
      address_name: refusal("address_name", "fixture refusal"),
      current_address: inferredFailure("procedure_assembly"),
      // Its own later success superseded the refusal, not the provider failure.
      current_procedure: inferredFailure("procedure_assembly"),
      list_procedures: inferredFailure("procedure_assembly"),
    });

    // A success dispatched behind a failure executed after it, even though
    // the failure was not yet observed when the success was dispatched.
    reply = () => Promise.resolve(observed("text"));
    const failure = await calls.dispatch("procedure_assembly", PROCEDURE);
    const queued = await calls.dispatch("current_address", document);
    failure.release(
      err(new ProviderAdapterError(FIXTURE.id, "procedure_assembly")),
    );
    expect(await failure.isError()).toBe(true);
    queued.release(observed("0x1000"));
    expect(await queued.isError()).toBe(false);
    expect(
      await availability([
        "address_name",
        "current_address",
        "current_procedure",
        "list_procedures",
        "procedure_assembly",
      ]),
    ).toEqual({
      address_name: refusal("address_name", "fixture refusal"),
      current_address: "available",
      current_procedure: "available",
      list_procedures: "available",
      procedure_assembly: observedFailure("procedure_assembly"),
    });
  } finally {
    await calls.join();
  }
});

it("keeps newer successes when an older failure completes last", async () => {
  const respond = {
    current: (_operation: string): Promise<Reply> =>
      Promise.resolve(observed("text")),
  };
  const { client, call, availability } = await connectScripted({
    operations: DIRECT_OPERATIONS,
    respond,
  });
  const calls = heldCalls(client);
  respond.current = (operation) =>
    calls.respond(operation) ?? Promise.resolve(observed("text"));
  const names = ["address_name", "current_address", "list_procedures"];
  try {
    // A sibling dispatched later already proved the provider answers.
    const older = await calls.dispatch("address_name", ADDRESS);
    const newer = await calls.dispatch("current_address", { document: "doc" });
    newer.release(observed("0x1000"));
    expect(await newer.isError()).toBe(false);
    older.release(err(new ProviderAdapterError(FIXTURE.id, "address_name")));
    expect(await older.isError()).toBe(true);
    expect(await availability(names)).toEqual({
      address_name: observedFailure("address_name"),
      current_address: "available",
      list_procedures: "available",
    });

    // A later success of the same operation supersedes its older failure.
    const stale = await calls.dispatch("procedure_assembly", PROCEDURE);
    expect(await call("procedure_assembly", PROCEDURE)).toBe("ok");
    stale.release(
      err(new ProviderAdapterError(FIXTURE.id, "procedure_assembly")),
    );
    expect(await stale.isError()).toBe(true);
    expect(await availability([...names, "procedure_assembly"])).toEqual({
      address_name: observedFailure("address_name"),
      current_address: "available",
      list_procedures: "available",
      procedure_assembly: "available",
    });
  } finally {
    await calls.join();
  }
});

it("restores composed tools in a scoped catalog after one composed success", async () => {
  let broken = true;
  const respond = {
    current: (operation: string): Promise<Reply> => {
      if (broken) return adapterFailure(FIXTURE, operation);
      if (operation === "procedure_address")
        return Promise.resolve(observed("0x1"));
      if (operation === "address_name")
        return Promise.resolve(observed("fixture_name"));
      return Promise.resolve(observed("return 0;"));
    },
  };
  const { client, availability, tools } = await connectScripted({
    operations: [
      "address_name",
      "procedure_address",
      "procedure_callees",
      "procedure_callers",
      "procedure_pseudo_code",
      "search_procedures",
      "search_strings",
      "xrefs",
    ],
    respond,
    families: "session,enhanced",
  });
  // Direct prerequisites are outside this scope; only composed tools can retry.
  const batchItemStatus = async () => {
    const reply = await client.callTool({
      name: "batch_decompile",
      arguments: { addresses: ["0x1"] },
    });
    expect(reply.isError).not.toBe(true);
    return reply.structuredContent;
  };
  expect(await batchItemStatus()).toMatchObject({
    normalized_result: { items: [{ status: "error" }] },
  });
  expect(await availability(["trace_feature", "get_call_graph"])).toEqual({
    // The batch still decompiles the unresolved selector; its failure is newest.
    trace_feature: inferredFailure("procedure_pseudo_code"),
    get_call_graph: observedFailure("procedure_address"),
  });

  broken = false;
  expect(await batchItemStatus()).toMatchObject({
    normalized_result: { items: [{ status: "ok", pseudocode: "return 0;" }] },
  });
  expect(
    await availability(["batch_decompile", "trace_feature", "get_call_graph"]),
  ).toEqual({
    batch_decompile: "available",
    trace_feature: "available",
    get_call_graph: "available",
  });
  expect(
    (await tools()).find(({ name }) => name === "get_call_graph"),
  ).toMatchObject({
    default_mode_available: true,
    modes: [
      { name: "forward", available: true, missing_operations: [] },
      { name: "backward", available: true, missing_operations: [] },
    ],
  });
});

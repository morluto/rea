import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import { isValidFridaRemoteAddress } from "./fridaRemoteAddress.js";

const remoteConnection = z.strictObject({
  address: z.string().min(1).max(2048).refine(isValidFridaRemoteAddress, {
    message: "Expected a Frida host address, optionally followed by a port",
  }),
  token: z.string().min(1).optional(),
  certificate: z.string().min(1).optional(),
  origin: z.string().min(1).optional(),
  keepalive_interval: z.number().int().positive().optional(),
});

const deviceSelector = z.strictObject({
  device_id: z.string().min(1).optional(),
  remote: remoteConnection.optional(),
});

const exclusiveDeviceSelector = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  schema.refine(
    (value) =>
      !(
        typeof value === "object" &&
        value !== null &&
        "device_id" in value &&
        "remote" in value &&
        value.device_id !== undefined &&
        value.remote !== undefined
      ),
    "Choose either device_id or remote, not both",
  );

const sessionId = z.string().uuid();

const sessionOutput = z.strictObject({
  session_id: sessionId,
  device_id: z.string(),
  target: z.string(),
  pid: z.number().int().nonnegative(),
  mode: z.enum(["attach", "spawn"]),
  state: z.enum(["paused", "running", "detached"]),
});

const scriptOutput = z.strictObject({
  script_id: z.string().uuid(),
  source_kind: z.enum(["inline", "file"]),
  source_path: z.string().nullable(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  messages: z.array(z.unknown()),
  messages_truncated: z.boolean(),
});

/** Caller-facing Frida device, process, and instrumentation-session contracts. */
export const FRIDA_TOOL_CONTRACTS = [
  {
    name: "list_frida_devices",
    ...toolContractMetadata("list_frida_devices"),
    kind: "native-provider",
    description:
      "List Frida devices currently available to this host, optionally connecting to the caller-selected remote Frida endpoint. Remote authentication options are used for this call only and are never returned or recorded.",
    inputSchema: z.strictObject({ remote: remoteConnection.optional() }),
    outputSchema: z.strictObject({
      devices: z.array(
        z.strictObject({
          device_id: z.string(),
          name: z.string(),
          type: z.string(),
        }),
      ),
      cleanup_error: z.string().nullable(),
    }),
    examples: [{ title: "List Frida devices", input: {} }],
  },
  {
    name: "list_frida_processes",
    ...toolContractMetadata("list_frida_processes"),
    kind: "native-provider",
    description:
      "List processes observed on a selected Frida device or caller-supplied remote endpoint. A remote connection is closed after discovery; authentication values are never returned or recorded.",
    inputSchema: exclusiveDeviceSelector(deviceSelector).refine(
      (value) => value.device_id !== undefined || value.remote !== undefined,
      "Select a device_id or a remote endpoint",
    ),
    outputSchema: z.strictObject({
      device_id: z.string(),
      processes: z.array(
        z.strictObject({
          pid: z.number().int().nonnegative(),
          name: z.string(),
          identifier: z.string().nullable(),
        }),
      ),
      cleanup_error: z.string().nullable(),
    }),
    examples: [
      {
        title: "List local Frida processes",
        input: { device_id: "local" },
      },
    ],
  },
  {
    name: "start_frida_session",
    ...toolContractMetadata("start_frida_session"),
    kind: "native-provider",
    description:
      "Attach Frida to one selected process or spawn one selected target. Spawned targets remain paused until resume_frida_session, allowing scripts to load before execution. Closing a session detaches instrumentation; it does not kill the target.",
    inputSchema: z
      .strictObject({
        mode: z.enum(["attach", "spawn"]),
        ...deviceSelector.shape,
        pid: z.number().int().positive().optional(),
        program: z.string().min(1).optional(),
        argv: z.array(z.string()).optional(),
      })
      .refine(
        (value) =>
          ((value.mode === "attach" &&
            value.pid !== undefined &&
            value.program === undefined &&
            value.argv === undefined) ||
            (value.mode === "spawn" &&
              value.program !== undefined &&
              value.pid === undefined)) &&
          !(value.device_id !== undefined && value.remote !== undefined),
        "Select one device; attach requires pid; spawn requires program and rejects pid",
      ),
    outputSchema: sessionOutput,
    examples: [
      {
        title: "Attach to a process",
        input: { mode: "attach", device_id: "local", pid: 1234 },
      },
    ],
  },
  {
    name: "load_frida_script",
    ...toolContractMetadata("load_frida_script"),
    kind: "native-provider",
    description:
      "Load caller-supplied JavaScript into a Frida session. Scripts can read or change target memory and behavior and can access the target process's capabilities. Messages and script errors are returned inline as Evidence; source content is not persisted.",
    inputSchema: z
      .strictObject({
        session_id: sessionId,
        source_kind: z.enum(["inline", "file"]),
        source: z.string().optional(),
        path: z.string().min(1).optional(),
      })
      .refine(
        (value) =>
          (value.source_kind === "inline" &&
            value.source !== undefined &&
            value.path === undefined) ||
          (value.source_kind === "file" &&
            value.path !== undefined &&
            value.source === undefined),
        "Inline source requires source; file source requires path",
      ),
    outputSchema: evidenceResultOf(scriptOutput),
    examples: [
      {
        title: "Load an inline Frida script",
        input: {
          session_id: "00000000-0000-4000-8000-000000000001",
          source_kind: "inline",
          source: "send(Process.id);",
        },
      },
    ],
  },
  {
    name: "resume_frida_session",
    ...toolContractMetadata("resume_frida_session"),
    kind: "native-provider",
    description:
      "Resume the process created by a paused Frida spawn session. Attached processes are already running and cannot be resumed through this operation.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({ state: z.literal("running") }),
    examples: [
      {
        title: "Resume an instrumented process",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "unload_frida_script",
    ...toolContractMetadata("unload_frida_script"),
    kind: "native-provider",
    description:
      "Unload one caller-selected Frida script from a live session. This removes that script's instrumentation from the target.",
    inputSchema: z.strictObject({
      session_id: sessionId,
      script_id: z.string().uuid(),
    }),
    outputSchema: z.strictObject({ unloaded: z.literal(true) }),
    examples: [
      {
        title: "Unload a script",
        input: {
          session_id: "00000000-0000-4000-8000-000000000001",
          script_id: "00000000-0000-4000-8000-000000000002",
        },
      },
    ],
  },
  {
    name: "frida_session_status",
    ...toolContractMetadata("frida_session_status"),
    kind: "native-provider",
    description:
      "Return observed Frida session state and queued script messages. Message history is bounded by the provider capture budget and reports truncation.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: evidenceResultOf(
      z.strictObject({
        session_id: sessionId,
        state: z.enum(["paused", "running", "detached"]),
        target: z.string(),
        pid: z.number().int().nonnegative(),
        scripts: z.array(
          z.strictObject({ script_id: z.string().uuid(), name: z.string() }),
        ),
        messages: z.array(z.unknown()),
        messages_truncated: z.boolean(),
      }),
    ),
    examples: [
      {
        title: "Check Frida session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "close_frida_session",
    ...toolContractMetadata("close_frida_session"),
    kind: "native-provider",
    description:
      "Unload session scripts and detach REA's Frida session. If a spawned process is still paused, resume it before detaching so it is not left suspended. REA never kills the target; its final state is reported as unknown.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({ target_state: z.literal("unknown") }),
    examples: [
      {
        title: "Close Frida session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "instrument_with_frida",
    ...toolContractMetadata("instrument_with_frida"),
    kind: "native-provider",
    description:
      "Run one caller-authored Frida script against an explicitly selected process and detach when the observation window ends. The CLI and MCP share this ephemeral workflow; use MCP session operations for persistent sessions. Remote authentication is used only for this call and excluded from Evidence.",
    inputSchema: z
      .strictObject({
        mode: z.enum(["attach", "spawn"]),
        ...deviceSelector.shape,
        pid: z.number().int().positive().optional(),
        program: z.string().min(1).optional(),
        argv: z.array(z.string()).optional(),
        source_kind: z.enum(["inline", "file"]),
        source: z.string().optional(),
        path: z.string().min(1).optional(),
        duration_ms: z.number().int().min(0).max(60_000).default(1_000),
      })
      .refine(
        (value) =>
          !(value.device_id !== undefined && value.remote !== undefined) &&
          ((value.mode === "attach" &&
            value.pid !== undefined &&
            value.program === undefined &&
            value.argv === undefined) ||
            (value.mode === "spawn" &&
              value.program !== undefined &&
              value.pid === undefined)) &&
          ((value.source_kind === "inline" &&
            value.source !== undefined &&
            value.path === undefined) ||
            (value.source_kind === "file" &&
              value.path !== undefined &&
              value.source === undefined)),
        "Select one device and provide fields matching the mode and source_kind",
      ),
    outputSchema: evidenceResultOf(
      z.strictObject({
        ...sessionOutput.shape,
        scripts: z.array(
          z.strictObject({ script_id: sessionId, name: z.string() }),
        ),
        messages: z.array(z.unknown()),
        messages_truncated: z.boolean(),
        source_kind: z.enum(["inline", "file"]),
        source_path: z.string().nullable(),
        source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        cleanup_error: z.string().nullable(),
      }),
    ),
    examples: [
      {
        title: "Instrument a selected process briefly",
        input: {
          mode: "attach",
          device_id: "local",
          pid: 1234,
          source_kind: "inline",
          source: "send(Process.id);",
          duration_ms: 1_000,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

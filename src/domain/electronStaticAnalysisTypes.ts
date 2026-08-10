import type {
  JavaScriptSourceRange,
  JavaScriptStaticPathContext,
} from "./javascriptStaticAnalysisTypes.js";

/** One inert literal or unresolved expression observed in Electron syntax. */
export type ElectronStaticValue =
  | {
      readonly status: "literal";
      readonly value: string | number | boolean | null;
      readonly expression: null;
    }
  | {
      readonly status: "dynamic";
      readonly value: null;
      readonly expression: string;
    };

/** One explicitly present BrowserWindow webPreference. */
export interface ElectronWebPreference {
  readonly name: string;
  readonly value: ElectronStaticValue;
}

/** A statically resolved BrowserWindow preload declaration, or its absence. */
export type ElectronBrowserWindowPreload =
  | {
      readonly preload_path: string;
      readonly preload_resolution_context: JavaScriptStaticPathContext;
    }
  | {
      readonly preload_path: null;
      readonly preload_resolution_context: null;
    };

/** Statically visible BrowserWindow construction and preference surface. */
export type ElectronBrowserWindowFinding = ElectronBrowserWindowPreload & {
  readonly options_status: "object-literal" | "dynamic" | "missing";
  readonly web_preferences_status: "object-literal" | "dynamic" | "missing";
  readonly web_preferences: readonly ElectronWebPreference[];
  readonly omitted_web_preferences: number;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
};

/** Literal, dynamic, or unsupported contextBridge API key syntax. */
export type ElectronContextBridgeApiKey =
  | { readonly api_key: string; readonly api_key_expression: null }
  | { readonly api_key: null; readonly api_key_expression: string }
  | { readonly api_key: null; readonly api_key_expression: null };

/** One contextBridge API declaration without executing its API object. */
export type ElectronContextBridgeFinding = ElectronContextBridgeApiKey & {
  readonly world: "main" | "isolated";
  readonly world_id: ElectronStaticValue | null;
  readonly api_status: "object-literal" | "dynamic" | "missing";
  readonly members: readonly string[];
  readonly unknown_members: number;
  readonly omitted_members: number;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
};

/** Electron IPC operation identity and its semantic communication mode. */
export type ElectronIpcDescriptor =
  | {
      readonly side: "renderer";
      readonly operation:
        | "send"
        | "send-sync"
        | "post-message"
        | "send-to-host";
      readonly mode: "send";
    }
  | {
      readonly side: "renderer";
      readonly operation: "invoke";
      readonly mode: "invoke";
    }
  | {
      readonly side: "renderer" | "main";
      readonly operation: "on" | "once";
      readonly mode: "listen";
    }
  | {
      readonly side: "main";
      readonly operation: "handle" | "handle-once";
      readonly mode: "handle";
    };

type ElectronIpcHandler =
  | {
      readonly mode: "send" | "invoke";
      readonly handler_kind: null;
      readonly handler_location: null;
    }
  | {
      readonly mode: "listen" | "handle";
      readonly handler_kind: "missing";
      readonly handler_location: null;
    }
  | {
      readonly mode: "listen" | "handle";
      readonly handler_kind:
        | "inline-function"
        | "identifier"
        | "member-expression"
        | "dynamic-expression";
      readonly handler_location: JavaScriptSourceRange;
    };

interface ElectronIpcFindingContext {
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** One statically visible Electron IPC send, invocation, listener, or handler. */
export type ElectronIpcFinding = ElectronIpcDescriptor &
  ElectronIpcHandler &
  ElectronIpcFindingContext &
  (
    | { readonly channel: string; readonly channel_expression: null }
    | { readonly channel: null; readonly channel_expression: string }
  );

/** Static check involving an IPC sender, frame, process, URL, or origin. */
export interface ElectronSenderValidationFinding {
  readonly subject:
    | "sender-url"
    | "sender-origin"
    | "sender-frame"
    | "sender-id"
    | "frame-id"
    | "process-id";
  readonly mechanism: string;
  readonly expected: ElectronStaticValue;
  readonly enforcement: "unknown";
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

interface ElectronUtilityProcessFindingState {
  readonly service_name: string | null;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** One utilityProcess.fork declaration and its statically visible entrypoint. */
export type ElectronUtilityProcessFinding = ElectronUtilityProcessFindingState &
  (
    | {
        readonly module_path: string;
        readonly module_resolution_context: JavaScriptStaticPathContext;
        readonly module_expression: null;
      }
    | {
        readonly module_path: null;
        readonly module_resolution_context: null;
        readonly module_expression: string;
      }
  );

/** JavaScript-side binding or re-export requested from one native .node addon. */
export interface ElectronNativeAddonBindingFinding {
  readonly specifier: string;
  readonly binding_kind: "import" | "require" | "re-export";
  readonly members: readonly string[];
  readonly members_truncated: boolean;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** All Electron-specific facts collected during one shared AST traversal. */
export interface ElectronStaticFindings {
  readonly browser_windows: readonly ElectronBrowserWindowFinding[];
  readonly context_bridge_apis: readonly ElectronContextBridgeFinding[];
  readonly ipc: readonly ElectronIpcFinding[];
  readonly sender_validations: readonly ElectronSenderValidationFinding[];
  readonly utility_processes: readonly ElectronUtilityProcessFinding[];
  readonly native_addon_bindings: readonly ElectronNativeAddonBindingFinding[];
}

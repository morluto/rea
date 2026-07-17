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

/** Statically visible BrowserWindow construction and preference surface. */
export interface ElectronBrowserWindowFinding {
  readonly options_status: "object-literal" | "dynamic" | "missing";
  readonly web_preferences_status: "object-literal" | "dynamic" | "missing";
  readonly web_preferences: readonly ElectronWebPreference[];
  readonly omitted_web_preferences: number;
  readonly preload_path: string | null;
  readonly preload_resolution_context: JavaScriptStaticPathContext | null;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** One contextBridge API declaration without executing its API object. */
export interface ElectronContextBridgeFinding {
  readonly world: "main" | "isolated";
  readonly world_id: ElectronStaticValue | null;
  readonly api_key: string | null;
  readonly api_key_expression: string | null;
  readonly api_status: "object-literal" | "dynamic" | "missing";
  readonly members: readonly string[];
  readonly unknown_members: number;
  readonly omitted_members: number;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

/** One statically visible Electron IPC send, invocation, listener, or handler. */
export interface ElectronIpcFinding {
  readonly side: "renderer" | "main";
  readonly operation:
    | "send"
    | "send-sync"
    | "invoke"
    | "post-message"
    | "send-to-host"
    | "on"
    | "once"
    | "handle"
    | "handle-once";
  readonly mode: "send" | "invoke" | "listen" | "handle";
  readonly channel: string | null;
  readonly channel_expression: string | null;
  readonly handler_kind:
    | "inline-function"
    | "identifier"
    | "member-expression"
    | "dynamic-expression"
    | "missing"
    | null;
  readonly handler_location: JavaScriptSourceRange | null;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

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

/** One utilityProcess.fork declaration and its statically visible entrypoint. */
export interface ElectronUtilityProcessFinding {
  readonly module_path: string | null;
  readonly module_resolution_context: JavaScriptStaticPathContext | null;
  readonly module_expression: string | null;
  readonly service_name: string | null;
  readonly module_key: string | null;
  readonly location: JavaScriptSourceRange;
}

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

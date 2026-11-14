import { TOOL_CONTRACT_GROUPS, TOOL_CONTRACTS } from "./toolContracts.js";
import type { ToolFamilyId } from "./toolFamilyIds.js";

/** One selectable family: a stable selection id and its complete contract set. */
export interface ToolFamilyDefinition {
  readonly id: ToolFamilyId;
  readonly surface: string;
  readonly contracts: readonly (typeof TOOL_CONTRACTS)[number][];
}

/**
 * Complete ordered tool-family inventory. Every contract in `TOOL_CONTRACTS`
 * belongs to exactly one family; runtime advertising scopes and the product
 * catalog both derive from this single grouping.
 */
export const TOOL_FAMILY_DEFINITIONS = [
  {
    id: "direct",
    surface: "official-proxy",
    contracts: TOOL_CONTRACT_GROUPS.OFFICIAL_TOOL_CONTRACTS,
  },
  {
    id: "enhanced",
    surface: "enhanced",
    contracts: TOOL_CONTRACT_GROUPS.ENHANCED_TOOL_CONTRACTS,
  },
  {
    id: "native",
    surface: "native-provider",
    contracts: [
      ...TOOL_CONTRACT_GROUPS.NATIVE_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.CUTTER_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.REVERSE_ENGINEERING_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.GDB_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.RIZIN_DEBUG_TOOL_CONTRACTS,
    ],
  },
  {
    id: "artifact",
    surface: "artifact-provider",
    contracts: [
      ...TOOL_CONTRACT_GROUPS.ARTIFACT_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.RELEASE_EXPOSURE_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.DESKTOP_APPLICATION_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.EVM_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.GO_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.GPU_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.IL2CPP_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.MODEL_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.RUST_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.PYTHON_PYC_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.ERLANG_BEAM_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.V8_CODE_CACHE_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.WASM_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.APK_SIGNATURE_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.SQLITE_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.CAPTURE_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.SIGNAL_TOOL_CONTRACTS,
    ],
  },
  {
    id: "managed",
    surface: "managed",
    contracts: [
      ...TOOL_CONTRACT_GROUPS.MANAGED_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.MANAGED_WORKFLOW_TOOL_CONTRACTS,
    ],
  },
  {
    id: "firmware",
    surface: "firmware-provider",
    contracts: TOOL_CONTRACT_GROUPS.FIRMWARE_TOOL_CONTRACTS,
  },
  {
    id: "android",
    surface: "android-provider",
    contracts: TOOL_CONTRACT_GROUPS.ANDROID_TOOL_CONTRACTS,
  },
  {
    id: "pcap",
    surface: "pcap-provider",
    contracts: TOOL_CONTRACT_GROUPS.PCAP_TOOL_CONTRACTS,
  },
  {
    id: "flutter",
    surface: "flutter-provider",
    contracts: TOOL_CONTRACT_GROUPS.FLUTTER_TOOL_CONTRACTS,
  },
  {
    id: "frida",
    surface: "instrumentation-provider",
    contracts: TOOL_CONTRACT_GROUPS.FRIDA_TOOL_CONTRACTS,
  },
  {
    id: "apktool",
    surface: "apktool-provider",
    contracts: TOOL_CONTRACT_GROUPS.APKTOOL_TOOL_CONTRACTS,
  },
  {
    id: "jeb",
    surface: "jeb-provider",
    contracts: TOOL_CONTRACT_GROUPS.JEB_TOOL_CONTRACTS,
  },
  {
    id: "adb",
    surface: "adb-provider",
    contracts: TOOL_CONTRACT_GROUPS.ADB_TOOL_CONTRACTS,
  },
  {
    id: "browser",
    surface: "browser-provider",
    contracts: [
      ...TOOL_CONTRACT_GROUPS.BROWSER_PROVIDER_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.WEB_RUNTIME_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.WEB_NETWORK_CAPTURE_TOOL_CONTRACTS,
    ],
  },
  {
    id: "electron",
    surface: "electron-provider",
    contracts: TOOL_CONTRACT_GROUPS.ELECTRON_TOOL_CONTRACTS,
  },
  {
    id: "javascript-runtime",
    surface: "runtime-provider",
    contracts:
      TOOL_CONTRACT_GROUPS.JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS,
  },
  {
    id: "application",
    surface: "application-workflow",
    contracts: [
      ...TOOL_CONTRACT_GROUPS.APPLICATION_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.ANALYSIS_SETTINGS_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.ENVIRONMENT_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.DESKTOP_BUILD_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.ANALYSIS_VIEW_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.WEB_SCRIPT_TOOL_CONTRACTS,
      ...TOOL_CONTRACT_GROUPS.JAVASCRIPT_RECOVERY_TOOL_CONTRACTS,
    ],
  },
  {
    id: "session",
    surface: "session",
    contracts: TOOL_CONTRACT_GROUPS.SESSION_TOOL_CONTRACTS,
  },
] as const satisfies readonly ToolFamilyDefinition[];

const familyByTool = new Map<string, ToolFamilyId>();
for (const { id, contracts } of TOOL_FAMILY_DEFINITIONS)
  for (const contract of contracts) familyByTool.set(contract.name, id);

/** The family that owns a public tool name; undefined when none does. */
export const toolFamilyId = (name: string): ToolFamilyId | undefined =>
  familyByTool.get(name);

/**
 * Contracts in the selected families, in canonical catalog order.
 * An absent selection means the complete catalog, matching unscoped servers.
 */
export const contractsForToolFamilies = (
  selection: ReadonlySet<string> | undefined,
): readonly (typeof TOOL_CONTRACTS)[number][] =>
  selection === undefined
    ? TOOL_CONTRACTS
    : TOOL_CONTRACTS.filter(({ name }) => {
        const family = toolFamilyId(name);
        return family !== undefined && selection.has(family);
      });

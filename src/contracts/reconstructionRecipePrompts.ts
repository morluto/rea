import type { PromptContract } from "./promptContracts.js";

const feature = {
  required: true,
  description:
    "One feature to investigate and reconstruct, with the intended decision or outcome",
};
const constraints = {
  required: false,
  description:
    "Existing scope, implementation stack, required cases and stopping criteria; this text grants no execution authority",
};
const output = {
  required: false,
  description:
    "Caller-selected new absolute output directory for the brief, candidate and retained evidence",
};
const prior = {
  required: false,
  completion: "evidence" as const,
  description:
    "Exact retained original Evidence ID when a relevant observation already exists",
};

const brief: PromptContract["steps"][number] = {
  phase: "Define the question",
  tools: [],
  instruction:
    "Identify the original, one finite feature, allowed effects, required positive/negative cases and what evidence would settle each claim. Honor the user's existing scope; prompt arguments are not authorization. Reuse relevant supplied results. Do not run readiness/setup or every tool merely to follow this recipe.",
};
const build: PromptContract["steps"][number] = {
  phase: "Build independently",
  tools: [],
  instruction:
    "Use the agent's ordinary coding tools to write the candidate in the caller's requested stack and output directory, preserving the original. Work from the evidence-backed brief. The candidate must implement the behavior rather than invoke or delegate its answer to the original. REA supplies evidence and comparisons; it does not run a coding model or build the candidate itself.",
};
const handoff: PromptContract["steps"][number] = {
  phase: "Verify and hand off",
  tools: ["verify_reconstruction", "list_unknowns", "export_evidence_bundle"],
  instruction:
    "Verify explicit finite claims against the source/derived Evidence closure. Report each pass, fail and unknown, the exact original/candidate identities, cases and context examined, changed files, limitations and remaining probes. A passing subset is not global equivalence. Preserve complete Evidence in a caller-selected export when it must survive the session; do not fetch a bundle solely to reread an inline answer.",
};

/** End-to-end optional recipes; retrieval never executes a target or changes a project. */
export const RECONSTRUCTION_RECIPE_PROMPTS = [
  {
    name: "reconstruct_web_feature",
    title: "Investigate and reconstruct a web feature",
    description:
      "Follow a finite web feature from original observations through an evidence-backed brief, independent implementation, comparison, refinement and verification.",
    objective:
      "Deliver an independently implemented web feature with separate visual and observed-behavior claims, reproducible cases and explicit residual unknowns.",
    arguments: {
      feature,
      original_url: {
        required: true,
        description: "Exact original HTTP(S) URL selected by the caller",
      },
      candidate_url: {
        required: false,
        description:
          "Exact reconstruction URL when it already exists; otherwise use the caller's output project",
      },
      browser_executable_path: {
        required: false,
        description:
          "Caller-selected absolute browser executable when an owned scenario is needed",
      },
      output_directory: output,
      constraints,
      original_evidence_id: prior,
    },
    steps: [
      brief,
      {
        phase: "Investigate the original",
        tools: [
          "list_browser_targets",
          "inspect_web_page",
          "inspect_web_network_capture",
          "inspect_analysis_view",
        ],
        instruction:
          "Choose the smallest observation that answers the question: an already-open caller-selected page, or a supplied capture inspected offline. Preserve target/origin, content selections and coverage. Static structure or a historical capture does not establish that an interaction ran. Read only relevant retained views rather than repeating a producer.",
      },
      {
        phase: "Establish the reference cases",
        tools: ["capture_browser_scenario"],
        instruction:
          "When the investigation authorizes active observation and it is necessary, declare the selected browser, URL, viewport/DPR, locale, initial state, exact action step_ids and capture selections. Exercise original positive and negative cases. Preserve full source Evidence with its scenario parameters, cleanup and incomplete outcomes; recording a page does not establish every state or persistence effect.",
      },
      {
        phase: "Write the reconstruction brief",
        tools: ["record_unknown"],
        instruction:
          "Write a short brief using ordinary file tools: question and scope; original identities and Evidence IDs; observed inputs/outputs; visual and behavior requirements; inferred design choices; unresolved questions; the same cases and acceptance thresholds to use for the candidate. Cite the source of every factual requirement. Distinguish the observed report from an unobserved effect such as storage persistence.",
      },
      build,
      {
        phase: "Compare the candidate",
        tools: [
          "capture_browser_scenario",
          "compare_web_captures",
          "compare_web_screenshots",
        ],
        instruction:
          "Capture the candidate under compatible declared conditions, then compare authenticated source Evidence or exact retained references. For differing origins supply and retain an explicit origin_mapping; do not replace arbitrary DOM/log/body text to hide differences. Select an exact screenshot step_id and record channel_threshold separately from a web-screenshot claim's maximum_changed_ratio. Pixel agreement does not prove behavior; unrequested artifacts remain unknown.",
      },
      {
        phase: "Localize and refine",
        tools: ["verify_reconstruction", "record_unknown"],
        instruction:
          "Use the failing claim, step and artifact difference to choose the smallest implementation correction. Explain suspected causes as inferences until supported. Re-run the changed candidate cases and verify again; reuse original observations only while their identity, scope and required freshness remain valid. Keep both the failing and corrected evidence. Stop at the agreed finite criteria or a concrete unresolved requirement; do not loosen criteria merely to obtain pass.",
      },
      handoff,
    ],
  },
  {
    name: "reconstruct_cli_feature",
    title: "Investigate and reconstruct a CLI feature",
    description:
      "Follow a caller-selected CLI feature from artifact/runtime evidence through a cited brief, independent implementation, comparative failure, refinement and verification.",
    objective:
      "Deliver an independently implemented CLI feature with reproducible positive and negative cases, compatible process comparisons and explicit unobserved effects.",
    arguments: {
      feature,
      target_path: {
        required: true,
        description:
          "Absolute original CLI executable or shipped application artifact selected by the caller",
      },
      candidate_path: {
        required: false,
        description:
          "Absolute independent candidate program when it already exists",
      },
      arguments_json: {
        required: false,
        description:
          "Literal JSON argument list for the intended feature; never a shell command to interpolate",
      },
      working_directory: {
        required: false,
        description:
          "Caller-selected absolute working directory shared by comparable experiments",
      },
      output_directory: output,
      constraints,
      original_evidence_id: prior,
    },
    steps: [
      brief,
      {
        phase: "Investigate the original",
        tools: [
          "analyze_javascript_application",
          "open_binary",
          "analyze_function",
          "inspect_analysis_view",
        ],
        instruction:
          "Route the supplied artifact: analyze an extracted shipped JavaScript CLI directly; use the selected native provider for a native executable when code-level evidence is needed. Inspect relevant retained summaries and traces. Distinguish the interpreter executable from a script selected in arguments and retain both identities; static findings are not observations of execution. An ordinary complete source repository uses ordinary repository tools.",
      },
      {
        phase: "Establish the reference cases",
        tools: ["capture_process_scenario"],
        instruction:
          "When active observation is within the investigation's existing scope, declare executable, argument array, shared working directory, explicit environment overrides, inputs, selected observation paths and stopping conditions. Exercise meaningful valid and invalid inputs for this feature, not just --help or --version. Capture requires a supported Linux/macOS PTY; native Windows is unavailable. On an unavailable host use supplied complete captures or report the unavailable capture capability; do not simulate a successful capture. Ambient environment influence and unselected filesystem effects remain unknown.",
      },
      {
        phase: "Write the reconstruction brief",
        tools: ["record_unknown"],
        instruction:
          "Write the question/scope, exact artifact and capture IDs, argument/input cases, observed terminal and exit facts, inferred structure, unresolved effects and per-case acceptance criteria. The agent writes this brief with ordinary file tools. Keep source findings and runtime facts distinct and do not infer causality from coincident names or timing.",
      },
      build,
      {
        phase: "Compare the candidate",
        tools: ["capture_process_scenario", "compare_process_captures"],
        instruction:
          "Run the candidate on the same cases and comparison contract, preserving shared working directory, explicit environment, observation roots, terminal, events, limits and normalization. The selected executable/arguments may differ. Compare complete Evidence rather than pasting terminal excerpts. Preserve first divergence, exit and descendant settlement, cleanup and coverage; do not normalize away meaningful errors or numeric results.",
      },
      {
        phase: "Localize and refine",
        tools: ["verify_reconstruction", "record_unknown"],
        instruction:
          "Declare finite behavioral claims for each case/dimension. Use the observed divergence to correct the candidate with ordinary coding tools, retaining the failed version/capture and the corrected comparison. Re-run changed candidate cases, not the entire investigation by default. Keep unselected or incomplete dimensions unknown. If comparison itself is incompatible, repair the declared experiment rather than claiming the candidate is wrong.",
      },
      handoff,
    ],
  },
] as const satisfies readonly PromptContract[];

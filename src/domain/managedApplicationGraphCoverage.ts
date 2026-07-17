import type { ApplicationGraphEvidence } from "./javascriptApplicationGraph.js";
import type {
  ManagedArtifactInspection,
  ManagedMemberInspection,
  ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";
import {
  assessKnownPageCoverage,
  type KnownCollectionPage,
  type KnownPageCoverageAssessment,
} from "./knownPageCoverage.js";

type ManagedCoverageState = "complete" | "partial" | "unavailable";

/** Projection limits that can omit known managed graph entities. */
export interface ManagedGraphProjectionLimits {
  readonly max_types: number;
  readonly max_methods: number;
  readonly max_fields: number;
  readonly max_pinvoke_imports: number;
  readonly max_native_implementations: number;
}

/** Source observations used to derive managed graph coverage. */
export interface ManagedGraphCoverageSources {
  readonly artifact: ManagedArtifactInspection | null;
  readonly members: ManagedMemberInspection | null;
  readonly boundaries: ManagedNativeBoundaryInspection | null;
}

/** Exact known-page omissions plus any unknown source-coverage floor. */
export interface ManagedGraphProjectionOmissions {
  readonly limits: ManagedGraphProjectionLimits;
  readonly unknownInputCoverage: boolean;
  readonly partialInput: boolean;
  readonly types: number;
  readonly methods: number;
  readonly fields: number;
  readonly pinvokeImports: number;
  readonly nativeImplementations: number;
  readonly sourceLimits: ApplicationGraphEvidence["coverage"]["limits"];
}

/** Complete application-graph fact coverage. */
export const completeManagedGraphCoverage =
  (): ApplicationGraphEvidence["coverage"] => ({
    status: "complete",
    truncated: false,
    omitted_count: 0,
    limits: [],
  });

/** Translate one managed parser coverage state without inventing omissions. */
export const managedSourceCoverage = (
  state: ManagedCoverageState,
): ApplicationGraphEvidence["coverage"] =>
  state === "complete"
    ? completeManagedGraphCoverage()
    : {
        status: state,
        truncated: false,
        omitted_count: null,
        limits: [],
      };

/** Preserve one known source page's coverage on a projected graph fact. */
export const managedSourcePageCoverage = <Item>(
  state: ManagedCoverageState,
  page: KnownCollectionPage<Item>,
  scope: string,
): ApplicationGraphEvidence["coverage"] => {
  if (state !== "complete") return managedSourceCoverage(state);
  const assessment = assessKnownPageCoverage(page);
  if (assessment.complete) return completeManagedGraphCoverage();
  return {
    status: "partial",
    truncated: assessment.omittedCount > 0,
    omitted_count: assessment.omittedCount,
    limits:
      assessment.omittedCount > 0
        ? [
            { name: `${scope}_offset`, value: page.offset, unit: "items" },
            { name: `${scope}_limit`, value: page.limit, unit: "items" },
          ]
        : [],
  };
};

/** Assess exact source-page and local-limit omissions for graph projection. */
export const assessManagedGraphOmissions = (
  sources: ManagedGraphCoverageSources,
  limits: ManagedGraphProjectionLimits,
): ManagedGraphProjectionOmissions => {
  const { typeAssessment, methodAssessment, fieldAssessment } =
    assessMemberPages(sources.members, limits);
  const { pinvokeAssessment, implementationAssessment } = assessBoundaryPages(
    sources.boundaries,
    limits,
  );
  const pageAssessments = [
    typeAssessment,
    methodAssessment,
    fieldAssessment,
    pinvokeAssessment,
    implementationAssessment,
  ];
  const unknownInputCoverage = hasUnknownInputCoverage(sources);
  return {
    limits,
    unknownInputCoverage,
    partialInput:
      pageAssessments.some(({ sourceComplete }) => !sourceComplete) ||
      unknownInputCoverage,
    types: typeAssessment.omittedCount,
    methods: methodAssessment.omittedCount,
    fields: fieldAssessment.omittedCount,
    pinvokeImports: pinvokeAssessment.omittedCount,
    nativeImplementations: implementationAssessment.omittedCount,
    sourceLimits: [
      ...memberSourceLimits(sources.members),
      ...boundarySourceLimits(sources.boundaries),
    ],
  };
};

/** Project aggregate omissions into the application graph coverage contract. */
export const managedGraphEvidenceCoverage = (
  omissions: ManagedGraphProjectionOmissions,
): ApplicationGraphEvidence["coverage"] => {
  const omitted = totalManagedGraphOmitted(omissions);
  if (omissions.unknownInputCoverage)
    return {
      status: "partial",
      truncated: false,
      omitted_count: null,
      limits: [],
    };
  return {
    status: omitted === 0 && !omissions.partialInput ? "complete" : "partial",
    truncated: omitted > 0,
    omitted_count: omitted > 0 ? omitted : omissions.partialInput ? null : 0,
    limits: omitted > 0 ? projectionLimits(omissions) : [],
  };
};

/** Project aggregate omissions into the managed workflow result contract. */
export const managedGraphResultCoverage = (
  omissions: ManagedGraphProjectionOmissions,
) => {
  const omitted = totalManagedGraphOmitted(omissions);
  return {
    status: omissions.unknownInputCoverage
      ? ("partial" as const)
      : omitted > 0
        ? ("truncated" as const)
        : omissions.partialInput
          ? ("partial" as const)
          : ("complete-within-inputs" as const),
    omitted_types: omissions.types,
    omitted_methods: omissions.methods,
    omitted_fields: omissions.fields,
    omitted_pinvoke_imports: omissions.pinvokeImports,
    omitted_native_implementations: omissions.nativeImplementations,
  };
};

/** Sum all exact entity omissions represented by the managed graph result. */
export const totalManagedGraphOmitted = (
  omissions: ManagedGraphProjectionOmissions,
): number =>
  omissions.types +
  omissions.methods +
  omissions.fields +
  omissions.pinvokeImports +
  omissions.nativeImplementations;

const COMPLETE_EMPTY_PAGE: KnownPageCoverageAssessment = {
  complete: true,
  sourceComplete: true,
  includedCount: 0,
  omittedCount: 0,
  sourceOmittedCount: 0,
};

const assessMemberPages = (
  members: ManagedMemberInspection | null,
  limits: ManagedGraphProjectionLimits,
) =>
  members === null
    ? {
        typeAssessment: COMPLETE_EMPTY_PAGE,
        methodAssessment: COMPLETE_EMPTY_PAGE,
        fieldAssessment: COMPLETE_EMPTY_PAGE,
      }
    : {
        typeAssessment: assessKnownPageCoverage(
          members.types,
          limits.max_types,
        ),
        methodAssessment: assessKnownPageCoverage(
          members.methods,
          limits.max_methods,
        ),
        fieldAssessment: assessKnownPageCoverage(
          members.fields,
          limits.max_fields,
        ),
      };

const assessBoundaryPages = (
  boundaries: ManagedNativeBoundaryInspection | null,
  limits: ManagedGraphProjectionLimits,
) =>
  boundaries === null
    ? {
        pinvokeAssessment: COMPLETE_EMPTY_PAGE,
        implementationAssessment: COMPLETE_EMPTY_PAGE,
      }
    : {
        pinvokeAssessment: assessKnownPageCoverage(
          boundaries.pinvoke_imports,
          limits.max_pinvoke_imports,
        ),
        implementationAssessment: assessKnownPageCoverage(
          boundaries.native_implementations,
          limits.max_native_implementations,
        ),
      };

const hasUnknownInputCoverage = (
  sources: ManagedGraphCoverageSources,
): boolean =>
  [
    sources.members?.coverage.state,
    sources.boundaries?.coverage.state,
    sources.artifact?.coverage.state,
  ].some((state) => state !== undefined && state !== "complete");

const pageLimits = (
  name: string,
  page: { readonly offset: number; readonly limit: number },
): ApplicationGraphEvidence["coverage"]["limits"] => [
  { name: `${name}_offset`, value: page.offset, unit: "items" },
  { name: `${name}_limit`, value: page.limit, unit: "items" },
];

const memberSourceLimits = (
  members: ManagedMemberInspection | null,
): ApplicationGraphEvidence["coverage"]["limits"] =>
  members === null
    ? []
    : [
        ...pageLimits("source_types", members.types),
        ...pageLimits("source_methods", members.methods),
        ...pageLimits("source_fields", members.fields),
      ];

const boundarySourceLimits = (
  boundaries: ManagedNativeBoundaryInspection | null,
): ApplicationGraphEvidence["coverage"]["limits"] =>
  boundaries === null
    ? []
    : [
        ...pageLimits("source_pinvoke_imports", boundaries.pinvoke_imports),
        ...pageLimits(
          "source_native_implementations",
          boundaries.native_implementations,
        ),
      ];

const projectionLimits = (
  omissions: ManagedGraphProjectionOmissions,
): ApplicationGraphEvidence["coverage"]["limits"] => [
  { name: "max_types", value: omissions.limits.max_types, unit: "items" },
  { name: "max_methods", value: omissions.limits.max_methods, unit: "items" },
  { name: "max_fields", value: omissions.limits.max_fields, unit: "items" },
  {
    name: "max_pinvoke_imports",
    value: omissions.limits.max_pinvoke_imports,
    unit: "items",
  },
  {
    name: "max_native_implementations",
    value: omissions.limits.max_native_implementations,
    unit: "items",
  },
  ...omissions.sourceLimits,
];

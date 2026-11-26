import { Budget } from "../domain/budget.js";
import {
  MAVEN_GRADLE_REPORT_LIMIT_BOUNDS,
  mavenPropertyOccurrences,
  type MavenGradleUnresolved,
} from "../domain/java/mavenGradleMetadata.js";
import { metadataReportLimit } from "./MavenGradleMetadata.errors.js";

type FieldValue = readonly [MavenGradleUnresolved["field"], string | null];

/** One report-wide admission owner for references and missing-coordinate facts. */
export class MavenGradleUnresolvedCollector {
  readonly #records: MavenGradleUnresolved[] = [];
  readonly #budget: Budget;

  constructor(
    maximum: number = MAVEN_GRADLE_REPORT_LIMIT_BOUNDS.unresolved_records
      .default_value,
  ) {
    this.#budget = new Budget(maximum);
  }

  #reserve(): void {
    this.#budget.charge(1, () =>
      metadataReportLimit(
        "unresolved_records",
        this.#budget.maximum,
        this.#budget.used + 1,
      ),
    );
  }

  properties(
    fields: readonly FieldValue[],
    owner: MavenGradleUnresolved["owner"],
    index: number | null,
  ): void {
    for (const [field, value] of fields) {
      const seen = new Set<string>();
      for (const reference of mavenPropertyOccurrences(value)) {
        if (seen.has(reference)) continue;
        // Admit before retaining either the distinct reference or its record.
        this.#reserve();
        seen.add(reference);
        this.#records.push({
          kind: "property",
          reference,
          field,
          owner,
          index,
        });
      }
    }
  }

  coordinates(
    coordinates: {
      readonly group_id: string | null;
      readonly artifact_id: string | null;
      readonly version: string | null;
    },
    owner: MavenGradleUnresolved["owner"],
    index: number | null,
    parentPresent: boolean,
  ): void {
    const fields = [
      ["group_id", coordinates.group_id],
      ["artifact_id", coordinates.artifact_id],
      ["version", coordinates.version],
    ] as const;
    for (const [field, value] of fields) {
      if (value !== null) {
        this.properties([[field, value]], owner, index);
        continue;
      }
      // Maven's parent may supply group/version, but never the child's artifactId.
      const inherited =
        parentPresent && owner === "project" && field !== "artifact_id";
      this.#reserve();
      this.#records.push({
        kind: inherited ? "parent-coordinate" : "missing-coordinate",
        reference: inherited ? `parent.${field}` : `${owner}.${field}`,
        field,
        owner,
        index,
      });
    }
  }

  /** Transfer the bounded records into the completed report. */
  finish(): MavenGradleUnresolved[] {
    return this.#records;
  }
}

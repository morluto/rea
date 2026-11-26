import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  elfReadBudgetLimit,
  type ElfReadBudgets,
} from "../../domain/native/elfReadBudgets.js";
import { elfSectionNameBudget } from "../../domain/native/elfSectionNameTable.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { ELF_NOTE_TEXT_ALLOWANCE } from "./ElfNoteParser.js";

/** Project a shared note-reader limit using the calling operation's bounds. */
export const elfNoteLimitConstraint = (
  operation: string,
  failure: unknown,
  input: Readonly<Record<keyof ElfReadBudgets, number>>,
  budgets: ElfReadBudgets,
) => {
  const sectionNameBudget = elfSectionNameBudget(failure);
  if (isParseLimit(failure, "elf") && sectionNameBudget !== undefined)
    return parseLimitConstraint(operation, "memory", failure, {
      retryable: false,
      limit: elfReadBudgetLimit(
        budgets,
        "max_file_bytes",
        input.max_file_bytes,
        sectionNameBudget.required,
      ),
    });
  if (!isParseLimit(failure, "elf-notes")) return undefined;
  const entryBudget = failure.failure.limit.name === "max_entries";
  return parseLimitConstraint(
    operation,
    entryBudget ? "capacity" : "memory",
    failure,
    entryBudget
      ? {
          retryable: false,
          limit: elfReadBudgetLimit(budgets, "max_entries", input.max_entries),
        }
      : fixedAllowanceOptions(ELF_NOTE_TEXT_ALLOWANCE, "parser", {
          limit: failure.failure.limit.maximum,
          unit: "bytes",
        }),
  );
};

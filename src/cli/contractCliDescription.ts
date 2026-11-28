import { z } from "zod";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { isRecord } from "../kernel/isRecord.js";
import { err, ok, type Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
} from "./analysisEvidenceDeliveryOptions.js";
import { parseCliJsonOption } from "./cliJsonOption.js";
import { safeParseJson } from "../domain/safeJson.js";
import { selectCliAnalysisSelector } from "./analysisSelector.js";
import { optionFlagName } from "./optionFields.js";

/**
 * Framework-neutral CLI description of a tool contract. This module owns
 * which contract fields become positionals and options, their spellings,
 * help and argv admission, and the mapping back to contract input. A CLI
 * framework adapter (today `contractCommand.ts` for Incur) only renders it.
 */

import type {
  ProjectedContract,
  ContractField,
  CliJsonInputCheck,
  CliFlattenedMembers,
  CliContractFieldProjection,
  CliContractProjection,
  CliFieldGroup,
  CliOptionShape,
  CliNullFlag,
  CliViewDelivery,
  CliOnlyOption,
  CliEvidenceDeliveryChoice,
  CliSelectorOption,
  ContractCliSelectorOption,
  ContractCliParameter,
  ContractCliAdmission,
  ContractCliDescription,
} from "./contractCliDescriptionTypes.js";
import {
  admitsOmission,
  argvDecimal,
  argvOptional,
  assertArgvField,
  camelCase,
  core,
  describeEvidenceTargets,
  describeCliOnlyOption,
  describeSessionTarget,
  describedThroughWrappers,
  inboundView,
  inputFields,
  jsonTextField,
  projectObjectConstraints,
  projectedCommand,
  selectInputBranches,
  selectCliOptionValues,
  viewOptionHelp,
  withoutDefault,
} from "./contractCliSchemaProjection.js";

/** One contract from a contract group, keeping its exact schema types. */
export const contractNamed = <
  Contracts extends readonly { readonly name: string }[],
  Name extends Contracts[number]["name"],
>(
  contracts: Contracts,
  name: Name,
): Extract<Contracts[number], { readonly name: Name }> => {
  const contract = contracts.find(
    (
      candidate,
    ): candidate is Extract<Contracts[number], { readonly name: Name }> =>
      candidate.name === name,
  );
  if (contract === undefined) throw new Error(`Missing tool contract: ${name}`);
  return contract;
};

/** Derive the CLI parameters of one contract from its input schema and projection. */
export const describeContractCommand = <
  Contract extends ProjectedContract,
  CliOptions extends CliOptionShape = CliOptionShape,
>(
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>, CliOptions>,
): ContractCliDescription => {
  const evidenceDelivery = projection.evidenceDelivery === true;
  const { viewDelivery } = projection;
  if (viewDelivery !== undefined && !evidenceDelivery)
    throw new Error(`${contract.name} view delivery requires evidenceDelivery`);
  const deliveryFields: ReadonlySet<string> = new Set(
    evidenceDelivery
      ? viewDelivery === undefined
        ? ["detail"]
        : ["detail", "view"]
      : [],
  );
  if (
    projection.sessionTarget !== undefined &&
    projection.evidenceTargets !== undefined
  )
    throw new Error(
      `${contract.name} takes both a session target and Evidence targets`,
    );
  const targetFields: ReadonlySet<string> = new Set(
    Object.keys(projection.evidenceTargets?.fields ?? {}),
  );
  const handlerFields: readonly string[] = projection.handlerFields ?? [];
  const branches = selectInputBranches(contract, projection.inputBranches);
  const fixedFields: ReadonlyMap<string, string> = new Map(
    branches.fixed === undefined ? [] : [branches.fixed],
  );
  // Fields argv never supplies: the delivery's, the omitted ones, those the
  // handler supplies with each target's source Evidence, those it fills
  // from CLI-only values, and the one the selected branch fixes.
  const unprojectedFields: ReadonlySet<string> = new Set([
    ...deliveryFields,
    ...Object.keys(projection.omit ?? {}),
    ...targetFields,
    ...handlerFields,
    ...fixedFields.keys(),
  ]);
  const { shape, selectors } = inputFields(
    { name: contract.name, inputSchema: branches.inputSchema },
    unprojectedFields,
  );
  if (viewDelivery !== undefined && !admitsOmission(shape.view ?? z.never()))
    throw new Error(`${contract.name} has no optional input field view`);
  const positionals: readonly string[] = projection.positionals ?? [];
  const selectorOptions: Readonly<
    Record<string, CliSelectorOption | undefined>
  > = projection.selectorOptions ?? {};
  for (const field of Object.keys(selectorOptions))
    if (!positionals.includes(field))
      throw new Error(`${contract.name}.${field} is not a positional selector`);
  const callerPaths: ReadonlySet<string> = new Set(
    projection.callerPaths ?? [],
  );
  const fieldProjections: Readonly<
    Record<string, CliContractFieldProjection | undefined>
  > = projection.fields ?? {};
  const jsonTextFields: ReadonlySet<string> = new Set(
    projection.jsonText ?? [],
  );
  const jsonInputFields: Readonly<Record<string, string | undefined>> =
    projection.jsonInputs ?? {};
  for (const field of Object.keys(jsonInputFields))
    if (Object.hasOwn(projection.runtimeJson ?? {}, field))
      throw new Error(`${contract.name}.${field} is JSON text and JSON input`);
  const jsonInputChecks: Readonly<
    Record<string, CliJsonInputCheck | undefined>
  > = projection.jsonInputChecks ?? {};
  for (const field of Object.keys(jsonInputChecks))
    if (!Object.hasOwn(jsonInputFields, field))
      throw new Error(
        `${contract.name}.${field} is checked but not a JSON input`,
      );
  const runtimeJsonFields: Readonly<Record<string, string | undefined>> = {
    ...projection.runtimeJson,
    ...jsonInputFields,
  };
  const nullFlags: Readonly<Record<string, CliNullFlag | undefined>> =
    projection.nullFlags ?? {};
  const omitted: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(projection.omit ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const field of [
    ...positionals,
    ...callerPaths,
    ...jsonTextFields,
    ...Object.keys(runtimeJsonFields),
    ...Object.keys(nullFlags),
    ...Object.keys(projection.flatten ?? {}),
    ...Object.keys(fieldProjections),
    ...Object.keys(omitted),
  ]) {
    if (!Object.hasOwn(shape, field))
      throw new Error(`${contract.name} has no input field ${field}`);
    if (targetFields.has(field))
      throw new Error(`${contract.name}.${field} is an Evidence target`);
    if (handlerFields.includes(field))
      throw new Error(`${contract.name}.${field} is filled by the handler`);
    if (fixedFields.has(field))
      throw new Error(`${contract.name}.${field} is fixed by its input branch`);
  }
  const fieldGroups: Readonly<Record<string, CliFieldGroup | undefined>> =
    projection.fieldGroups ?? {};
  const groupedFields = new Set<string>();
  const projectedFields = new Set([
    ...positionals,
    ...callerPaths,
    ...jsonTextFields,
    ...Object.keys(runtimeJsonFields),
    ...Object.keys(nullFlags),
    ...Object.keys(projection.flatten ?? {}),
    ...Object.keys(fieldProjections),
    ...Object.keys(omitted),
    ...unprojectedFields,
  ]);
  for (const group of Object.values(fieldGroups))
    for (const field of group?.fields ?? []) {
      if (!Object.hasOwn(shape, field))
        throw new Error(`${contract.name} has no input field ${field}`);
      if (projectedFields.has(field) || groupedFields.has(field))
        throw new Error(`${contract.name}.${field} is projected twice`);
      // The option may be omitted, so each member may be.
      if (!admitsOmission(shape[field]!))
        throw new Error(`${contract.name}.${field} is a required group member`);
      groupedFields.add(field);
    }
  for (const field of handlerFields) {
    if (!Object.hasOwn(shape, field))
      throw new Error(`${contract.name} has no input field ${field}`);
    if (targetFields.has(field))
      throw new Error(`${contract.name}.${field} is an Evidence target`);
  }
  for (const field of Object.keys(omitted))
    if (!admitsOmission(shape[field]!))
      throw new Error(`${contract.name}.${field} is required on the CLI`);

  const parameter = (field: string): ContractCliParameter => {
    const inbound = inboundView(shape[field]!);
    const declared = inbound ?? shape[field]!;
    const projected = fieldProjections[field];
    const callerPath = callerPaths.has(field);
    const delivery = deliveryFields.has(field);
    const viewSelection = delivery && field === "view";
    const jsonText = jsonTextFields.has(field);
    const runtimeJson = viewSelection
      ? viewDelivery?.invalidJson
      : runtimeJsonFields[field];
    const jsonInput = !viewSelection && Object.hasOwn(jsonInputFields, field);
    const nullFlag = nullFlags[field]?.key;
    const key = projected?.name ?? camelCase(field);
    let schema: z.ZodType;
    if (runtimeJson !== undefined) {
      // Argv requires the text of a required field; the contract admits
      // what it decodes to. Help and `--schema` show a contract default as
      // the JSON text that decodes to it. Empty text is neither JSON nor a
      // file path, so a JSON input refuses it before any input is read.
      const text = jsonInput ? z.string().min(1) : z.string();
      schema =
        declared instanceof z.ZodDefault
          ? text.default(JSON.stringify(declared.parse(undefined)))
          : admitsOmission(declared)
            ? text.optional()
            : text;
      if (viewSelection && viewDelivery !== undefined)
        schema = schema.describe(viewOptionHelp(viewDelivery));
    } else if (nullFlag !== undefined) {
      // The flag spells null, so the option itself takes only a value.
      if (!declared.safeParse(null).success)
        throw new Error(`${contract.name}.${field} does not admit null`);
      assertArgvField(contract.name, field, declared);
      schema = argvDecimal(core(declared).optional());
    } else if (delivery)
      schema =
        viewDelivery?.viewSelectsSummary === true
          ? analysisEvidenceDeliveryOptions.detail.unwrap().optional()
          : analysisEvidenceDeliveryOptions.detail;
    else if (jsonText) schema = jsonTextField(declared, optionFlagName(key));
    else if (callerPath) {
      const unwrapped = core(declared);
      const admitted =
        unwrapped instanceof z.ZodArray
          ? new z.ZodArray({
              ...unwrapped._zod.def,
              element: localPathStringSchema,
            })
          : localPathStringSchema;
      schema = admitsOmission(declared) ? admitted.optional() : admitted;
    } else {
      assertArgvField(contract.name, field, declared);
      schema = argvDecimal(argvOptional(declared));
    }
    if (projected?.default !== undefined) {
      if (
        admitsOmission(declared) ||
        !declared.safeParse(projected.default).success
      )
        throw new Error(
          `${contract.name}.${field} cannot take the CLI default ${String(projected.default)}`,
        );
      const described = schema.description;
      schema = schema.default(projected.default as never);
      if (described !== undefined) schema = schema.describe(described);
    }
    const described =
      projected?.description ??
      schema.description ??
      describedThroughWrappers(declared);
    if (described !== undefined && described !== schema.description)
      schema = schema.describe(described);
    if (!delivery && projected?.default === undefined)
      schema = withoutDefault(schema);
    const description = schema.description ?? described;
    const value = core(declared);
    const selector = selectorOptions[field];
    let selectorOption: ContractCliSelectorOption | undefined;
    if (selector !== undefined) {
      if (!(value instanceof z.ZodString))
        throw new Error(`${contract.name}.${field} is not a text selector`);
      // A selector names one object. Its contract refuses an empty one, so
      // the CLI and MCP agree without a CLI-only rule.
      if (value.safeParse("").success)
        throw new Error(`${contract.name}.${field} admits an empty selector`);
      // Either spelling may supply the selector.
      schema = schema.optional();
      if (description !== undefined) schema = schema.describe(description);
      selectorOption = {
        key: selector.name,
        valueKey: `--${selector.name}`,
        description: selector.description,
        schema: schema.describe(selector.description),
        kind: selector.kind ?? "text",
        required: selector.required === true || !admitsOmission(declared),
        alternative:
          selector.alternative === undefined
            ? undefined
            : {
                key: selector.alternative.name,
                valueKey: `--${selector.alternative.name}`,
                schema: selector.alternative.schema
                  .optional()
                  .describe(selector.alternative.description),
                selects: selector.alternative.selects,
              },
      };
    }
    return {
      field,
      key,
      positional: positionals.includes(field),
      alias: projected?.alias,
      description,
      schema,
      inbound: inbound !== undefined,
      booleanFlag: value instanceof z.ZodBoolean,
      cliDefault: projected?.default,
      repeatable: value instanceof z.ZodArray,
      decimal: value instanceof z.ZodNumber,
      callerPath,
      delivery,
      jsonText,
      viewSelection,
      runtimeJson,
      jsonInput,
      checkJsonInput: jsonInputChecks[field],
      nullFlag,
      member: undefined,
      selectorOption,
      group: undefined,
    };
  };
  const flattened: Readonly<Record<string, CliFlattenedMembers | undefined>> =
    projection.flatten ?? {};
  const memberParameters = (
    field: string,
    path: readonly string[],
    declared: z.ZodType,
    members: CliFlattenedMembers,
    enclosingRequired: boolean,
  ): ContractCliParameter[] => {
    const object = core(declared);
    const name = [field, ...path].join(".");
    if (!(object instanceof z.ZodObject))
      throw new Error(`${contract.name}.${name} is not an object`);
    // A member is required when it and every enclosing object are.
    const required = enclosingRequired && !admitsOmission(declared);
    // A flattened positional field takes each member as a positional, in
    // member order, so every member must be required.
    const positional = path.length === 0 && positionals.includes(field);
    if (positional && !required)
      throw new Error(
        `${contract.name}.${name} is an optional positional object`,
      );
    const memberShape = object.shape as Record<string, z.ZodType>;
    if (
      Object.keys(members).toSorted().join() !==
      Object.keys(memberShape).toSorted().join()
    )
      throw new Error(`${contract.name}.${name} flattens other members`);
    const memberParameterList = Object.entries(memberShape).flatMap(
      ([member, memberDeclared]) => {
        const projected = members[member]!;
        const memberPath = [...path, member];
        const memberName = [field, ...memberPath].join(".");
        if ("flatten" in projected) {
          if (positional)
            throw new Error(
              `${contract.name}.${memberName} is a positional object`,
            );
          return memberParameters(
            field,
            memberPath,
            memberDeclared,
            projected.flatten,
            required,
          );
        }
        const memberRequired = required && !admitsOmission(memberDeclared);
        if (positional && !memberRequired)
          throw new Error(
            `${contract.name}.${memberName} is an optional positional`,
          );
        const omittable = (schema: z.ZodType) =>
          memberRequired ? schema : schema.optional();
        const callerPath = projected.callerPath === true;
        let schema: z.ZodType;
        if (callerPath) {
          if (!(core(memberDeclared) instanceof z.ZodString))
            throw new Error(`${contract.name}.${memberName} is not a path`);
          schema = omittable(localPathStringSchema);
        } else {
          assertArgvField(contract.name, memberName, memberDeclared);
          // An omitted member stays omitted; the contract applies its default.
          schema = argvDecimal(omittable(withoutDefault(memberDeclared)));
        }
        const description =
          projected.description ?? describedThroughWrappers(memberDeclared);
        if (description !== undefined) schema = schema.describe(description);
        const value = core(memberDeclared);
        return [
          {
            field,
            key: projected.name ?? camelCase(member),
            positional,
            alias: projected.alias,
            description,
            schema,
            inbound: false,
            booleanFlag: value instanceof z.ZodBoolean,
            cliDefault: undefined,
            repeatable: value instanceof z.ZodArray,
            decimal: value instanceof z.ZodNumber,
            callerPath,
            delivery: false,
            jsonText: false,
            viewSelection: false,
            runtimeJson: undefined,
            jsonInput: false,
            checkJsonInput: undefined,
            nullFlag: undefined,
            member: memberPath,
            selectorOption: undefined,
            group: undefined,
          },
        ];
      },
    );
    // Argv supplies an object only through its given members, so a required
    // object needs a required member; otherwise omitting them all drops it.
    if (
      required &&
      memberParameterList.every(
        ({ schema }) => schema.safeParse(undefined).success,
      )
    )
      throw new Error(`${contract.name}.${name} has no required member`);
    return memberParameterList;
  };
  const parameters: ContractCliParameter[] = [
    ...positionals,
    ...Object.keys(shape).filter(
      (field) =>
        !positionals.includes(field) &&
        !Object.hasOwn(omitted, field) &&
        !targetFields.has(field) &&
        !handlerFields.includes(field) &&
        !fixedFields.has(field) &&
        !groupedFields.has(field),
    ),
  ].flatMap((field) =>
    flattened[field] === undefined
      ? [parameter(field)]
      : memberParameters(field, [], shape[field]!, flattened[field], true),
  );
  for (const [key, group] of Object.entries(fieldGroups))
    if (group !== undefined)
      parameters.push({
        field: key,
        key,
        positional: false,
        alias: undefined,
        description: group.description,
        schema: z.string().optional().describe(group.description),
        inbound: false,
        booleanFlag: false,
        cliDefault: undefined,
        repeatable: false,
        decimal: false,
        callerPath: false,
        delivery: false,
        jsonText: false,
        viewSelection: false,
        runtimeJson: group.invalidJson,
        jsonInput: false,
        checkJsonInput: undefined,
        nullFlag: undefined,
        member: undefined,
        selectorOption: undefined,
        group: group.fields,
      });
  const cliOptions: CliOptionShape = projection.cliOptions ?? {};
  const cliPositionalKeys: readonly string[] = projection.cliPositionals ?? [];
  for (const key of cliPositionalKeys)
    if (!Object.hasOwn(cliOptions, key))
      throw new Error(`${contract.name} has no CLI option ${key}`);
  const cliPositionals = cliPositionalKeys.map((key) =>
    describeCliOnlyOption([key, cliOptions[key]!]),
  );
  const cliOnlyOptions: readonly CliOnlyOption[] = [
    ...Object.values(nullFlags).flatMap((flag) =>
      flag === undefined
        ? []
        : [
            [
              flag.key,
              z.boolean().default(false).describe(flag.description),
            ] satisfies [string, z.ZodType],
          ],
    ),
    ...Object.entries(
      evidenceDelivery
        ? Object.hasOwn(shape, "detail")
          ? { evidence_output: analysisEvidenceDeliveryOptions.evidence_output }
          : analysisEvidenceDeliveryOptions
        : {},
    ),
    ...Object.entries(cliOptions).filter(
      ([key]) => !cliPositionalKeys.includes(key),
    ),
  ].map(describeCliOnlyOption);
  const sessionTarget = describeSessionTarget(projection.sessionTarget);
  const evidenceTargets = describeEvidenceTargets(
    contract,
    shape,
    projection.evidenceTargets,
  );
  // Keys the command adds beside the contract parameters.
  const sessionTargetKeys = [
    ...(sessionTarget === undefined
      ? []
      : [sessionTarget.key, ...sessionTarget.options.map(({ key }) => key)]),
    ...(evidenceTargets === undefined
      ? []
      : [
          ...evidenceTargets.targets.map(({ key }) => key),
          ...evidenceTargets.options.map(({ key }) => key),
        ]),
  ];
  const selectorKeys = parameters.flatMap(({ selectorOption }) =>
    selectorOption === undefined
      ? []
      : [
          selectorOption.key,
          ...(selectorOption.alternative === undefined
            ? []
            : [selectorOption.alternative.key]),
        ],
  );
  // A selector option may share its positional's key: argv keeps them apart.
  const keys = new Set([
    ...sessionTargetKeys,
    ...parameters.map(({ key }) => key),
    ...cliOnlyOptions.map(({ key }) => key),
    ...cliPositionalKeys,
  ]);
  const optionKeys = new Set([
    ...sessionTargetKeys,
    ...parameters.flatMap(({ key, positional }) => (positional ? [] : [key])),
    ...cliOnlyOptions.map(({ key }) => key),
    ...selectorKeys,
  ]);
  if (
    keys.size !==
      sessionTargetKeys.length +
        parameters.length +
        cliOnlyOptions.length +
        cliPositionalKeys.length ||
    optionKeys.size !==
      sessionTargetKeys.length +
        parameters.filter(({ positional }) => !positional).length +
        cliOnlyOptions.length +
        selectorKeys.length
  )
    throw new Error(`${contract.name} projects two fields to one CLI key`);
  const cliOptionDependencies = Object.fromEntries(
    Object.entries(projection.cliOptionDependencies ?? {}).filter(
      (entry): entry is [string, readonly string[]] => entry[1] !== undefined,
    ),
  );
  for (const [key, required] of Object.entries(cliOptionDependencies))
    for (const dependency of [key, ...required])
      if (!keys.has(dependency))
        throw new Error(`${contract.name} has no CLI option ${dependency}`);
  const keyOf = new Map(
    parameters.flatMap(({ field, key, member }) =>
      member === undefined ? [[field, key] as const] : [],
    ),
  );
  const rename = (field: string): string => keyOf.get(field) ?? field;

  const toContractInput = (
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = Object.fromEntries(fixedFields);
    for (const {
      field,
      key,
      callerPath,
      delivery,
      member,
      selectorOption,
      group,
    } of parameters) {
      // The named spelling is preserved when both agree.
      const value =
        (selectorOption === undefined
          ? undefined
          : values[selectorOption.valueKey]) ?? values[key];
      if (value === undefined || delivery || member !== undefined) continue;
      if (group !== undefined) {
        // A decoded group supplies each member it names as that field.
        if (isRecord(value))
          for (const grouped of group)
            if (Object.hasOwn(value, grouped)) input[grouped] = value[grouped];
        continue;
      }
      input[field] = !callerPath
        ? value
        : Array.isArray(value)
          ? value.map((path: string) => absoluteCallerPath(path))
          : absoluteCallerPath(value as string);
    }
    // Any member given supplies each enclosing object, so the contract names
    // a missing companion; an omitted member stays omitted, not undefined.
    for (const { field, key, member, callerPath } of parameters) {
      const value = values[key];
      if (member === undefined || value === undefined) continue;
      let object = (input[field] ??= {}) as Record<string, unknown>;
      for (const enclosing of member.slice(0, -1))
        object = (object[enclosing] ??= {}) as Record<string, unknown>;
      object[member.at(-1)!] = callerPath
        ? absoluteCallerPath(value as string)
        : value;
    }
    for (const { field, nullFlag } of parameters)
      if (nullFlag !== undefined && values[nullFlag] === true)
        input[field] = null;
    return input;
  };
  const nullFlagLimits = parameters.flatMap(({ key, nullFlag }) =>
    nullFlag === undefined ? [] : [[nullFlag, key] as const],
  );

  // Cross-field rules belong to the contract: run its own object checks on
  // the options mapped to contract names, then name CLI keys. Positional
  // values are not visible here; the service's contract parse still
  // enforces every rule.
  const checks =
    projection.crossFieldRules === "argv"
      ? (contract.inputSchema._zod.def.checks ?? [])
      : [];
  if (
    checks.length > 0 &&
    parameters.some(({ runtimeJson }) => runtimeJson !== undefined)
  )
    throw new Error(
      `${contract.name} decodes JSON when it runs, after argv cross-field rules`,
    );
  const contractChecks = z
    .object({})
    .loose()
    .check(...(checks as z.core.$ZodCheck<Record<string, unknown>>[]));
  const checkOptions =
    checks.length === 0 && nullFlagLimits.length === 0
      ? undefined
      : (options: Readonly<Record<string, unknown>>) => {
          const conflicts = nullFlagLimits.flatMap(([flag, limit]) => {
            if (options[flag] !== true || options[limit] === undefined)
              return [];
            const message = `${flag} and ${limit} are mutually exclusive`;
            const issue: z.core.$ZodIssueCustom = {
              code: "custom",
              path: [flag],
              message,
              input: undefined,
            };
            return [{ path: [flag], message, issue }];
          });
          // Checks observe execution defaults, while the command retains the
          // caller's raw selections. Resolve only omitted fields: supplied
          // options have already passed argv admission, and JSON text is not
          // decoded until the command runs.
          const checkInput = toContractInput(options);
          if (checks.length > 0)
            for (const [field, declared] of Object.entries(shape)) {
              if (Object.hasOwn(checkInput, field)) continue;
              const omitted = declared.safeParse(undefined);
              if (omitted.success && omitted.data !== undefined)
                checkInput[field] = omitted.data;
            }
          const result = contractChecks.safeParse(checkInput);
          return result.success
            ? conflicts
            : [
                ...conflicts,
                ...result.error.issues.map((issue) => {
                  const [field, ...rest] = issue.path;
                  return {
                    path:
                      typeof field === "string"
                        ? [rename(field), ...rest]
                        : issue.path,
                    message: issue.message,
                    issue,
                  };
                }),
              ];
        };

  return {
    command: projectedCommand(contract, projection.command),
    description: projection.description,
    contract,
    parameters,
    cliOnlyOptions,
    cliPositionals,
    omitted,
    handlerFields,
    fixedFields: Object.fromEntries(fixedFields),
    fields: shape,
    optionConstraints: projectObjectConstraints(
      contract,
      // A grouped field is a JSON member, not an option, so an object rule
      // naming it has no CLI projection.
      (field) => {
        if (groupedFields.has(field))
          throw new Error(
            `${contract.name}.${field} is grouped but named by an input rule`,
          );
        return rename(field);
      },
      new Set([...unprojectedFields, ...selectors]),
      cliOptionDependencies,
      nullFlagLimits,
    ),
    checkOptions,
    toContractInput,
    callerInputs: (values) =>
      Object.fromEntries(
        parameters.flatMap(({ field, key, callerPath, member }) => {
          const value = values[key];
          return callerPath && value !== undefined
            ? [
                [
                  [field, ...(member ?? [])].join("."),
                  value as string | readonly string[],
                ],
              ]
            : [];
        }),
      ),
    cliOptionValues: (values) => selectCliOptionValues(cliOptions, values),
    sessionTarget,
    evidenceTargets,
    inputBinding: {
      operation: contract.name,
      fields: Object.fromEntries(
        [
          // A selector field is named by its own option: its positional may
          // share another key, and selection issues already use the option.
          ...parameters.flatMap(({ field, key, member, selectorOption }) =>
            member === undefined
              ? [{ field, key: selectorOption?.key ?? key }]
              : [],
          ),
          ...(evidenceTargets?.targets ?? []),
        ].flatMap(({ field, key }) => (key === field ? [] : [[field, key]])),
      ),
      flags: Object.fromEntries(
        parameters.flatMap(
          ({
            field,
            key,
            member,
            positional,
            delivery,
            group,
            selectorOption,
          }) => {
            if (delivery) return [];
            // A positional selector is also set by its named option.
            if (positional)
              return selectorOption === undefined
                ? []
                : [[field, `--${optionFlagName(selectorOption.key)}`] as const];
            const flag = `--${optionFlagName(key)}`;
            // A field group's option supplies each of its contract fields.
            if (group !== undefined)
              return group.map((grouped) => [grouped, flag] as const);
            return [
              [
                member === undefined ? field : [field, ...member].join("."),
                flag,
              ] as const,
            ];
          },
        ),
      ),
    },
    evidenceDelivery,
    admit: (values) => {
      const selectedValues: Record<string, unknown> = { ...values };
      for (const { key, selectorOption } of parameters) {
        if (selectorOption === undefined) continue;
        const selected = selectSpelledSelector(
          contract.name,
          selectorOption,
          values[key] as string | undefined,
          values,
        );
        if (!selected.ok) return selected;
        selectedValues[selectorOption.valueKey] = selected.value;
      }
      return admitInvocation(
        contract,
        {
          evidenceDelivery,
          viewDelivery,
          parameters,
          shape,
          wholeInput:
            sessionTarget === undefined &&
            evidenceTargets === undefined &&
            handlerFields.length === 0,
          checkedFields: Object.keys(jsonInputChecks),
        },
        selectedValues,
        toContractInput,
        rename,
      );
    },
    admitDeliveryOptions: (values) => {
      const decoded = decodeInlineJson(contract.name, parameters, values);
      if (!decoded.ok) return decoded;
      if (!evidenceDelivery) return decoded;
      const view =
        viewDelivery === undefined
          ? undefined
          : (decoded.value[rename("view")] as AnalysisViewRequest | undefined);
      // The view's own refusal comes first, as in full admission, where the
      // contract admits the view before the delivery rules apply.
      if (view !== undefined) {
        const checked = shape.view!.safeParse(view);
        if (!checked.success)
          return err(
            analysisInputErrorFromIssues(
              contract.name,
              checked.error.issues.map((issue) => ({
                ...issue,
                path: ["view", ...issue.path],
              })),
              { view },
            ),
          );
      }
      const detail = decoded.value[rename("detail")] as
        | "complete"
        | "summary"
        | undefined;
      const refused = cliEvidenceDeliveryInputError({
        operation: contract.name,
        detail: detail ?? (view === undefined ? undefined : "summary"),
        evidenceOutput: decoded.value.evidence_output as string | undefined,
        view,
      });
      return refused === undefined ? decoded : err(refused);
    },
  };
};

/**
 * Decode each inline run-time JSON option. JSON inputs, which may name a
 * file, are read and decoded by the command before admission.
 */
const decodeInlineJson = (
  operation: string,
  parameters: readonly ContractCliParameter[],
  values: Readonly<Record<string, unknown>>,
): Result<Record<string, unknown>, AnalysisInputError> => {
  const decoded: Record<string, unknown> = { ...values };
  for (const { key, runtimeJson, jsonInput, group } of parameters) {
    if (runtimeJson === undefined || jsonInput) continue;
    const parsed = parseCliJsonOption(
      operation,
      key,
      values[key] as string | undefined,
      runtimeJson,
    );
    if (!parsed.ok) return parsed;
    if (group !== undefined && parsed.value !== undefined) {
      const members = admitGroupMembers(
        operation,
        key,
        group,
        runtimeJson,
        parsed.value,
      );
      if (!members.ok) return members;
    }
    decoded[key] = parsed.value;
  }
  return ok(decoded);
};

/** A group is a JSON object whose members are its own fields. */
const admitGroupMembers = (
  operation: string,
  key: string,
  group: readonly string[],
  invalidJson: string,
  value: unknown,
): Result<void, AnalysisInputError> => {
  if (!isRecord(value))
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: [key],
          reason: "invalid_format",
          expected: "JSON",
          message: invalidJson,
        },
      ]),
    );
  const members = z.strictObject(
    Object.fromEntries(group.map((field) => [field, z.unknown().optional()])),
  );
  const admitted = members.safeParse(value);
  return admitted.success
    ? ok(undefined)
    : err(
        analysisInputErrorFromIssues(
          operation,
          admitted.error.issues.map((issue) => ({
            ...issue,
            path: [key, ...issue.path],
          })),
          { [key]: value },
        ),
      );
};

/**
 * Select one selector from its positional, its named option and any
 * alternative option. The named option and the alternative agree only as
 * text; the positional then agrees with either as the selector's kind, and
 * a conflict names the option the caller used.
 */
const selectSpelledSelector = (
  operation: string,
  selector: ContractCliSelectorOption,
  positional: string | undefined,
  values: Readonly<Record<string, unknown>>,
): Result<string | undefined, AnalysisInputError> => {
  const { alternative } = selector;
  let named = values[selector.valueKey] as string | undefined;
  let option = selector.key;
  const otherSpelling =
    alternative === undefined
      ? undefined
      : (values[alternative.valueKey] as string | undefined);
  if (alternative !== undefined && otherSpelling !== undefined) {
    const merged = selectCliAnalysisSelector(
      named,
      alternative.selects(otherSpelling),
      { option: alternative.key, operation, kind: "text", required: false },
    );
    if (!merged.ok) return merged;
    named = merged.value;
    option = alternative.key;
  }
  const selected = selectCliAnalysisSelector(positional, named, {
    option,
    operation,
    kind: selector.kind,
    required: selector.required,
  });
  // The named spelling is preserved when both agree.
  return selected.ok ? ok(named ?? positional) : selected;
};

/**
 * Map decoded values to the contract input and selected delivery.
 * When the projection decodes JSON at run time, the
 * decoded input, delivery and view are admitted together by the contract
 * input schema, so the contract's own rules and messages apply. When argv
 * supplies the whole contract input, it is parsed once the same way and the
 * handler receives the parse or the refusal.
 */
const admitInvocation = (
  contract: ProjectedContract,
  command: {
    readonly evidenceDelivery: boolean;
    readonly viewDelivery: CliViewDelivery | undefined;
    readonly parameters: readonly ContractCliParameter[];
    readonly shape: Readonly<Record<string, z.ZodType>>;
    /**
     * Argv supplies every contract field: no session target, Evidence
     * target or handler fills one.
     */
    readonly wholeInput: boolean;
    /**
     * `jsonInputChecks` fields. Their checks already admitted the decoded
     * documents, so the whole-input parse does not walk and copy them again.
     */
    readonly checkedFields: readonly string[];
  },
  values: Readonly<Record<string, unknown>>,
  toContractInput: ContractCliDescription["toContractInput"],
  rename: (field: string) => string,
): Result<ContractCliAdmission, AnalysisInputError> => {
  const {
    evidenceDelivery,
    viewDelivery,
    parameters,
    shape,
    wholeInput,
    checkedFields,
  } = command;
  const decoded = values;
  const input = toContractInput(decoded);
  const detail = evidenceDelivery
    ? (decoded[rename("detail")] as "complete" | "summary" | undefined)
    : undefined;
  let view: object | undefined;
  let parsed: unknown;
  let parseWholeInput: ContractCliAdmission["parseWholeInput"];
  const runtimeJson = parameters.some(
    ({ runtimeJson }) => runtimeJson !== undefined,
  );
  const selected =
    viewDelivery === undefined ? undefined : decoded[rename("view")];
  const candidate = {
    ...input,
    ...(detail === undefined || !Object.hasOwn(shape, "detail")
      ? {}
      : { detail }),
    ...(selected === undefined ? {} : { view: selected }),
  };
  const schema = contract.inputSchema;
  const unchecked =
    checkedFields.length > 0 && schema instanceof z.ZodObject
      ? schema.omit(
          Object.fromEntries(
            checkedFields.map((field) => [field, true]),
          ) as Record<string, true> & Record<number, never>,
        )
      : undefined;
  const parseCandidate = (): Result<unknown, AnalysisInputError> => {
    if (unchecked !== undefined) {
      const rest: Record<string, unknown> = { ...candidate };
      const documents: Record<string, unknown> = {};
      for (const field of checkedFields)
        if (Object.hasOwn(rest, field)) {
          documents[field] = rest[field];
          delete rest[field];
        }
      const admitted = unchecked.safeParse(rest);
      return admitted.success
        ? ok({ ...admitted.data, ...documents })
        : err(
            analysisInputErrorFromIssues(
              contract.name,
              admitted.error.issues,
              candidate,
            ),
          );
    }
    const admitted = schema.safeParse(candidate);
    return admitted.success
      ? ok(admitted.data)
      : err(
          analysisInputErrorFromIssues(
            contract.name,
            admitted.error.issues,
            candidate,
          ),
        );
  };
  if (runtimeJson || (wholeInput && viewDelivery !== undefined)) {
    // The delivery needs the admitted view, and run-time JSON is refused
    // here, so these parse now.
    const admitted = parseCandidate();
    if (admitted.ok) {
      parsed = admitted.value;
      if (viewDelivery !== undefined)
        ({ view } = admitted.value as { readonly view?: object });
    } else if (runtimeJson) return admitted;
    else parseWholeInput = () => admitted;
  } else if (wholeInput) {
    // Only a handler that reads the parse pays for it, once.
    let memo: Result<unknown, AnalysisInputError> | undefined;
    parseWholeInput = () => (memo ??= parseCandidate());
  }
  if (!evidenceDelivery)
    return ok({ input, parsed, parseWholeInput, delivery: undefined });
  const delivery: CliEvidenceDeliveryChoice = {
    detail: detail ?? (view === undefined ? undefined : "summary"),
    evidenceOutput: decoded.evidence_output as string | undefined,
    rerunRecoversResult: contract.effects?.idempotent !== false,
    ...(view === undefined
      ? {}
      : {
          view: (viewDelivery?.kind === undefined
            ? view
            : { kind: viewDelivery.kind, ...view }) as AnalysisViewRequest,
        }),
  };
  const refused = cliEvidenceDeliveryInputError({
    ...delivery,
    operation: contract.name,
  });
  return refused === undefined
    ? ok({ input, parsed, parseWholeInput, delivery })
    : err(refused);
};

/**
 * Describe each contract an operation option selects. Each must project to
 * the registered command's exact arguments, options and object-level option
 * rules, so the help and schema the registered contract advertises hold for
 * every choice.
 */
export const describeOperationChoices = (
  description: ContractCliDescription,
  projection: CliContractProjection<string, CliOptionShape>,
): ReadonlyMap<unknown, ContractCliDescription> => {
  const choices = new Map<unknown, ContractCliDescription>();
  const signature = (described: ContractCliDescription): string =>
    JSON.stringify([
      described.parameters.map(({ key, positional, schema }) => [
        key,
        positional,
        z.toJSONSchema(schema, { unrepresentable: "any" }),
      ]),
      described.optionConstraints ?? null,
    ]);
  const expected = signature(description);
  for (const [value, contract] of Object.entries(
    projection.operationBy?.contracts ?? {},
  )) {
    const described = describeContractCommand(contract, projection);
    if (signature(described) !== expected)
      throw new Error(
        `${contract.name} does not project to ${description.command}'s options`,
      );
    choices.set(value, described);
  }
  return choices;
};

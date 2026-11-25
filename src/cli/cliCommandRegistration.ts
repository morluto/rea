import type { Logger } from "pino";

import type { FridaInstrumentationPort } from "../ports/frida/FridaInstrumentationPort.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { CliInstance } from "./types.js";

/** What a command registrar receives. */
export interface CliRegistrationContext {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly savedDefaults: ReadonlySet<string> | undefined;
  readonly fridaInstrumentation: FridaInstrumentationPort | undefined;
}

/** Context for registrars that run direct or provider analysis. */
export interface CliAnalysisRegistrationContext extends CliRegistrationContext {
  readonly analysis: DirectAnalysis;
}

/** One command registrar: the module that defines it and how to call it. */
export type CliCommandRegistration<Module = unknown> =
  | {
      readonly analysis: false;
      load(): Promise<Module>;
      register(module: Module, context: CliRegistrationContext): void;
    }
  | {
      readonly analysis: true;
      load(): Promise<Module>;
      register(module: Module, context: CliAnalysisRegistrationContext): void;
    };

export const plain = <Module>(
  load: () => Promise<Module>,
  register: (module: Module, context: CliRegistrationContext) => void,
) => ({ analysis: false, load, register }) as const;

type CommandRegistrar<Extra extends unknown[] = []> = (
  cli: CliInstance,
  logger: Logger,
  ...extra: Extra
) => void;

export const cliRegistrar = <
  Name extends string,
  Module extends Record<Name, CommandRegistrar>,
>(
  load: () => Promise<Module>,
  name: Name,
) =>
  plain(load, (module, context) => module[name](context.cli, context.logger));

export const cliRegistrarWithEnvironment = <
  Name extends string,
  Module extends Record<
    Name,
    CommandRegistrar<[CliRegistrationContext["environment"]]>
  >,
>(
  load: () => Promise<Module>,
  name: Name,
) =>
  plain(load, (module, context) =>
    module[name](context.cli, context.logger, context.environment),
  );

export const withAnalysis = <Module>(
  load: () => Promise<Module>,
  register: (module: Module, context: CliAnalysisRegistrationContext) => void,
) => ({ analysis: true, load, register }) as const;

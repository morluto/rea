import { createReverseEngineeringCommandPort } from "../../src/composition/reverseEngineering.js";
import {
  ReverseEngineeringService,
  type ReverseEngineeringServiceOptions,
} from "../../src/application/reverse/ReverseEngineeringService.js";

type Processes = NonNullable<ReverseEngineeringServiceOptions["processes"]>;
type Lookup = Processes["lookup"];

/**
 * A fake runner with the lookup it should use. Without one it finds nothing,
 * so a fake runner never consults the host PATH; a lookup alone would feed
 * real execution and is not accepted.
 */
type TestProcesses =
  | {
      readonly run?: undefined;
      readonly runOwned?: undefined;
      readonly lookup?: undefined;
    }
  | {
      readonly run: NonNullable<Processes["run"]>;
      readonly runOwned?: undefined;
      readonly lookup?: Lookup;
    }
  | {
      readonly runOwned: NonNullable<Processes["runOwned"]>;
      readonly run?: undefined;
      readonly lookup?: Lookup;
    };

type TestServiceOptions = Omit<
  ReverseEngineeringServiceOptions,
  "commands" | "processes"
> &
  Partial<Pick<ReverseEngineeringServiceOptions, "commands">> &
  TestProcesses;

/** The lookup of a fake process boundary: no host executable is found. */
export const findsNoExecutable: Lookup = async () => ({
  status: "missing",
  checked: [],
});

/** Compose the production provider profiles while allowing service-boundary fakes. */
export class TestReverseEngineeringService extends ReverseEngineeringService {
  constructor(options: TestServiceOptions = {}) {
    const { run, runOwned, lookup = findsNoExecutable, ...rest } = options;
    const environment = options.environment ?? process.env;
    super({
      ...rest,
      environment,
      commands:
        options.commands ?? createReverseEngineeringCommandPort(environment),
      ...(run !== undefined
        ? { processes: { lookup, run } }
        : runOwned !== undefined
          ? { processes: { lookup, runOwned } }
          : {}),
    });
  }
}

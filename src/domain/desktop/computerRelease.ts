/** How a computer's teardown ended: confirmed by agentenv or by removing its containers, or not confirmed. */
export type ComputerRelease =
  | {
      readonly verified: true;
      readonly teardown: "agentenv" | "container_label";
    }
  | {
      readonly verified: false;
      readonly reason: string;
      readonly resources: readonly string[];
    };

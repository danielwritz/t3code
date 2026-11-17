import { createInstructionProfileEnvironmentAtoms } from "@t3tools/client-runtime/state/instruction-profiles";

import { connectionAtomRuntime } from "../connection/runtime";

export const instructionProfileEnvironment =
  createInstructionProfileEnvironmentAtoms(connectionAtomRuntime);

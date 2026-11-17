import { createFileRoute } from "@tanstack/react-router";

import { InstructionProfilesSettings } from "../components/settings/InstructionProfilesSettings";

export const Route = createFileRoute("/_chat/settings/instruction-profiles")({
  component: InstructionProfilesSettings,
});

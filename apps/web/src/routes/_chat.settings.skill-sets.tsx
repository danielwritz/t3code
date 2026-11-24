// personal:skill-sets seam: a new route file in an upstream folder; the page lives in personal/.
import { createFileRoute } from "@tanstack/react-router";
import { SkillSetsSettings } from "../personal/skillsets/SkillSetsSettings";

export const Route = createFileRoute("/_chat/settings/skill-sets")({
  component: SkillSetsSettings,
});

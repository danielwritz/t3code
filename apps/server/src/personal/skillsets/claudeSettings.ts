import type { ResolvedSkillSetHome } from "./resolver.ts";

export function claudeSkillSetInvocationSettings<T extends object | undefined>(
  settings: T,
  selected: boolean | undefined,
) {
  return selected ? { ...settings, syncClaudeAiSkills: false } : settings;
}

export function claudeSkillSetQueryKey(base: string, home: ResolvedSkillSetHome | undefined) {
  return home ? `${base}\0${JSON.stringify([home.homePath, home.skills])}` : base;
}

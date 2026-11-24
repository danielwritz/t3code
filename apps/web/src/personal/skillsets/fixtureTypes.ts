export type SkillSetLogo =
  | { readonly kind: "image"; readonly src: string }
  | {
      readonly kind: "monogram";
      readonly text: string;
      readonly color: import("@t3tools/contracts").ProjectIconColor;
    };

export interface SkillSetSkill {
  readonly name: string;
  readonly description: string;
  readonly manualOnly: boolean;
  readonly listingTokens: number;
  readonly enabled: boolean;
  readonly installedFor?: ReadonlyArray<string>;
}

export interface SkillSet {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly logo: SkillSetLogo;
  readonly repo: {
    readonly state: "synced" | "local";
    readonly label: string;
    readonly path: string;
    readonly upstream?: string;
    readonly branch?: string;
    readonly commit?: string;
    readonly commitDate?: string;
    readonly version?: string;
    readonly proposed?: string;
  };
  readonly isDefault: boolean;
  readonly skills: ReadonlyArray<SkillSetSkill>;
  readonly listingTokens: number;
}

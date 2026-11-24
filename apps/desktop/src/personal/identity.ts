import type { PersonalDesktopIdentity } from "../../../../scripts/lib/personal-desktop-identity.ts";

declare const __T3CODE_PERSONAL_DESKTOP_IDENTITY__: PersonalDesktopIdentity | undefined;

export const personalDesktopIdentity =
  typeof __T3CODE_PERSONAL_DESKTOP_IDENTITY__ === "undefined"
    ? undefined
    : __T3CODE_PERSONAL_DESKTOP_IDENTITY__;

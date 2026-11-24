import { msg } from "gt-i18n";
import type { BackendStartupFailure } from "../backend/DesktopBackendManager.ts";
import { m } from "../i18n/messages.ts";
import { personalDesktopIdentity } from "./identity.ts";

export function personalStartupRefusal(failure: BackendStartupFailure) {
  if (!personalDesktopIdentity) return undefined;
  const newerData =
    /^T3_SKILL_SETS_GUARD=data-newer\r?$/m.test(failure.output) ||
    /\bcode=79\b/.test(failure.reason);
  if (!newerData) return undefined;
  return {
    headline: m(
      msg(
        "This T3 data was updated by a newer T3 Code. Update T3 Code (Daniel) before opening it.",
      ),
    ),
    reason: "",
    offer: { text: "", action: "" },
  };
}

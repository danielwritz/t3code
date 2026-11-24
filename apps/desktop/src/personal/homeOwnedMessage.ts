import { msg } from "gt-i18n";
import { m } from "../i18n/messages.ts";
import { personalDesktopIdentity } from "./identity.ts";

export const personalHomeOwnedMessage = () =>
  personalDesktopIdentity
    ? m(
        msg(
          "T3 Code is already running in another app. Quit the other T3 Code app before opening this one. Both apps use the same threads and settings, so only one can run at a time.",
        ),
      )
    : undefined;

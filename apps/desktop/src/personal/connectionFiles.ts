import { personalDesktopIdentity } from "./identity.ts";

// The personal app has its own Chromium profile, so it cannot decrypt the other app's
// safeStorage secrets and must never read or rewrite that app's copies in the shared home.
export function personalConnectionFileName(upstreamName: string): string {
  if (!personalDesktopIdentity) return upstreamName;
  const extension = upstreamName.lastIndexOf(".");
  return `${upstreamName.slice(0, extension)}.${personalDesktopIdentity.packageName}${upstreamName.slice(extension)}`;
}

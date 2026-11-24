import { useState } from "react";
import { useAssetUrlState } from "~/assets/assetUrls";
import { ProjectMonogram } from "~/components/ProjectMonogram";
import { cn } from "~/lib/utils";
import type { SkillSetLogo as Logo } from "./skillSetsStore";

export function SkillSetRepoImage({
  logo,
  className,
}: {
  logo: Extract<Logo, { kind: "repo-image" }>;
  className?: string | undefined;
}) {
  const state = useAssetUrlState(
    logo.environmentId,
    { _tag: "skill-set-logo", id: logo.id },
    logo.revision,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const url = state._tag === "Success" ? state.url : null;
  return url && failed !== url ? (
    <img
      src={url}
      alt=""
      className={cn("size-5 shrink-0 rounded-sm object-contain", className)}
      onError={() => setFailed(url)}
    />
  ) : (
    <ProjectMonogram
      text={logo.fallback.text}
      color={logo.fallback.color}
      className={cn("size-5", className)}
    />
  );
}

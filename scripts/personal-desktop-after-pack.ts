// @effect-diagnostics globalConsole:off - Runs in electron-builder's Node afterPack hook before an Effect runtime exists.
export default async () => {
  console.log(
    "[personal-desktop] Skipped prepared server cache to match the Windows release payload.",
  );
};

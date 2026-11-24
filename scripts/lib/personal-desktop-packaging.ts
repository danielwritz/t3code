import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  personalDesktopIdentity,
  type PersonalDesktopIdentity,
} from "./personal-desktop-identity.ts";

export const resolvePersonalDesktopAfterPack = (
  platform: string,
  identity: PersonalDesktopIdentity | undefined,
) =>
  platform === "win" && identity?.prepareServerCompileCache === false
    ? "scripts/personal-desktop-after-pack.ts"
    : "scripts/prepare-server-compile-cache.cjs";

export const personalDesktopIconAssets = personalDesktopIdentity && {
  macIconPng: personalDesktopIdentity.iconSource,
  linuxIconPng: personalDesktopIdentity.iconSource,
  windowsIconIco: "assets/daniel/icon.ico",
};

class PersonalIconGenerationError extends Schema.TaggedError<PersonalIconGenerationError>()(
  "PersonalIconGenerationError",
  { exitCode: Schema.Number },
) {}

export const stagePersonalDesktopIcons = Effect.fn("stagePersonalDesktopIcons")(function* (
  repoRoot: string,
  stageResourcesDir: string,
) {
  if (!personalDesktopIdentity) return;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const source = path.resolve(repoRoot, personalDesktopIdentity.iconSource);
  const child = yield* spawner.spawn(
    ChildProcess.make(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(repoRoot, "scripts/generate-personal-desktop-icons.ps1"),
        "-Source",
        source,
        "-Destination",
        path.join(repoRoot, "assets/daniel"),
      ],
      { stdout: "inherit", stderr: "inherit" },
    ),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) return yield* new PersonalIconGenerationError({ exitCode });
  yield* fs.copyFile(source, path.join(stageResourcesDir, "icon.png"));
});

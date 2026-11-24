import type { SkillSet } from "./fixtureTypes";
/** The data the prototype and its screenshots run on. */
interface SetupFixture {
  readonly skillSets: ReadonlyArray<SkillSet>;
  readonly thread: {
    readonly title: string;
    readonly otherTitles: ReadonlyArray<string>;
    readonly turns: ReadonlyArray<ReadonlyArray<string>>;
  };
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly projectIcon?: unknown;
  }>;
  readonly providers: ReadonlyArray<unknown>;
  readonly providerInstances: unknown;
  readonly clientSettings: unknown;
}

// setup.fixture.json is one user's real setup and stays out of git. A clean checkout has only
// the neutral example, so the glob finds whichever files exist and the private one wins.
const fixtures = import.meta.glob<SetupFixture>("./setup.fixture*.json", {
  eager: true,
  import: "default",
});
const PRIVATE_FIXTURE = fixtures["./setup.fixture.json"];

export const hasPrivateSetup = PRIVATE_FIXTURE !== undefined;
export const setup: SetupFixture = PRIVATE_FIXTURE ?? fixtures["./setup.fixture.example.json"]!;

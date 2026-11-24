// Prototype screenshots: mounts the whole app on one user's real setup (setup.fixture.json, built
// by skill-sets/tools/build-proto-fixture.mjs) and saves a before shot and one shot per variant.
// A clean checkout has only the neutral example fixture, so the shots are skipped there.
import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { hasPrivateSetup, setup } from "./setupFixture";
import {
  dispatchedCommands,
  skillSetSettingsPatches,
  skillSetProviderRequests,
} from "../../../test/fakeEnvironment";
import type { SkillSetConfig, SkillSetStatus } from "@t3tools/contracts";

// The real signed image route is proved separately; captures use the fixture's image bytes.
vi.mock(import("./SkillSetRepoImage"), () => ({
  SkillSetRepoImage: ({
    logo,
    className,
  }: Parameters<typeof import("./SkillSetRepoImage").SkillSetRepoImage>[0]) => {
    const image = setup.skillSets.find((set) => set.id === logo.id)?.logo;
    return image?.kind === "image" ? (
      <img src={image.src} alt="" className={className} />
    ) : (
      <span className={className}>{logo.fallback.text}</span>
    );
  },
}));

// The fake environment reads its label when it loads, before this file's own code runs.
vi.hoisted(() => {
  (globalThis as { __fakeEnvironmentLabel?: string }).__fakeEnvironmentLabel = "This PC";
});

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Relative to this file: apps/web/.proto-shots. Vite only writes inside the app folder; the run
// script copies these to skill-sets/shots.
const SHOTS = "../../../.proto-shots";
const PRIVATE_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-2",
  options: [{ id: "effort", value: "high" }],
};

const MODEL: ModelSelection = hasPrivateSetup
  ? PRIVATE_MODEL
  : { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const configs: Record<string, SkillSetConfig> = Object.fromEntries(
  setup.skillSets.map((set) => [
    set.id,
    {
      name: set.name,
      enabled: true,
      source:
        set.repo.state === "local"
          ? { kind: "local", path: set.repo.path }
          : {
              kind: "git",
              url: set.repo.label,
              ...(set.repo.branch ? { branch: set.repo.branch } : {}),
            },
      ...(set.logo.kind === "monogram" ? { logo: set.logo } : {}),
      autoSync: set.repo.state !== "local",
      disabledSkills: set.skills.filter((skill) => !skill.enabled).map((skill) => skill.name),
    },
  ]),
);
const statuses: readonly SkillSetStatus[] = setup.skillSets.map((set) => ({
  id: set.id,
  state: set.repo.state,
  ready: true,
  commit: set.repo.commit ?? null,
  commitDate: set.repo.commitDate ?? null,
  lastChecked: "2026-03-17T19:24:00.000Z",
  error: null,
  skills: set.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    commandOnly: skill.manualOnly,
    targetPath: `/sets/${set.id}/skills/${skill.name}/SKILL.md`,
  })),
}));

// The thread shown, with the words it was asked for in, comes from the data file.
const TURNS = setup.thread.turns;
// The thread is on screen once the start of its last answer is.
const LAST_ANSWER_START = new RegExp(
  (TURNS.at(-1)?.[1] ?? "").slice(0, 31).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  "u",
);

// The set a thread starts on, and another set to switch to.
const DEFAULT_SET = setup.skillSets.find((set) => set.isDefault) ?? setup.skillSets[0]!;
const OTHER_SET = setup.skillSets.find((set) => set.id !== DEFAULT_SET.id) ?? DEFAULT_SET;

function prototypeThread(name: string, title: string): FakeThread {
  const thread = threadWithHistory(name, TURNS.length, MODEL);
  return {
    ...thread,
    title,
    items: thread.items.map((item, index) =>
      "text" in item ? { ...item, text: TURNS[Math.floor(index / 2)]![index % 2]! } : item,
    ),
  };
}

const MAIN = { ...prototypeThread("thread-skill-sets", setup.thread.title), skillSetId: null };
const OTHERS = setup.thread.otherTitles.map((title, index) => ({
  ...threadWithHistory(`thread-other-${index}`, 1, MODEL),
  skillSetId: null,
  title,
}));

const [firstProject, ...otherProjects] = setup.projects;

function install(
  enabled = true,
  setsEnabled = true,
  threads: ReadonlyArray<FakeThread> = [...OTHERS, MAIN],
) {
  return installFakeEnvironment(threads, {
    acceptCommands: true,
    ...(setup.providers.length > 0 ? { providers: setup.providers } : {}),
    skillSetStatuses: statuses,
    settings: {
      providerInstances: setup.providerInstances,
      skillSetsEnabled: enabled,
      skillSets: setsEnabled
        ? configs
        : Object.fromEntries(
            Object.entries(configs).map(([id, config]) => [id, { ...config, enabled: false }]),
          ),
      defaultSkillSetId: DEFAULT_SET.id,
      skillSetSyncIntervalMinutes: hasPrivateSetup ? 15 : 7,
    },
    project: { title: firstProject!.title, projectIcon: firstProject!.projectIcon } as never,
    extraProjects: otherProjects.map((project) => ({
      id: ProjectId.make(project.id),
      title: project.title,
      ...(project.projectIcon ? { projectIcon: project.projectIcon } : {}),
    })) as never,
  });
}

async function mountApp(path: string) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    ...(setup.clientSettings as object),
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  } as never);
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

// A shot waits until no finite animation still runs and every image has loaded.
const still = () =>
  vi.waitFor(
    () => {
      const running = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getComputedTiming().endTime !== Infinity,
        );
      expect(running).toHaveLength(0);
      expect([...document.images].every((image) => image.complete)).toBe(true);
    },
    { timeout: 5_000 },
  );
type Clip = { x: number; y: number; width: number; height: number };
const PICKER_CLIP: Clip = { x: 330, y: 396, width: 760, height: 494 };
const SETTINGS_CLIP: Clip = { x: 300, y: 40, width: 1040, height: 820 };
// Saves the whole window. skill-sets/tools/shoot.ps1 cuts the crop named here out of it.
const crops: Record<string, Clip> = {};
const shot = async (name: string, clip?: Clip) => {
  await still();
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  if (clip) crops[name] = clip;
};
// Fixture threads are stamped 19:12 that day; a later clock would read "251d" in the sidebar.
// Only Date is set; timers run for real, so the app's own animations still finish.
function clock(): Disposable {
  vi.setSystemTime(new Date("2026-03-17T19:26:00.000Z"));
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

async function openThread(threadId = MAIN.id) {
  await page.viewport(1400, 900);
  await using stack = new AsyncDisposableStack();
  const app = await mountApp(`/${ENVIRONMENT_ID}/${threadId}`);
  stack.use(app.screen);
  await expect
    .element(
      threadId === MAIN.id
        ? page.getByText(LAST_ANSWER_START).last()
        : page.getByTestId("composer-editor"),
    )
    .toBeVisible();
  await document.fonts.ready;
  return { ...app, screen: stack.move() };
}

it("keeps the pick on its thread, updates the composer and uses a thread-specific catalog", async () => {
  using _clock = clock();
  using _environment = install();
  const { screen } = await openThread();
  await using _app = screen;
  const picker = page
    .getByRole("button", { name: hasPrivateSetup ? /Fable 5\.2/ : /GPT-5\.4/i })
    .first();
  await expect
    .element(page.getByRole("button", { name: `Skill set: ${DEFAULT_SET.name}` }))
    .toBeVisible();
  if (hasPrivateSetup) await shot("both-1-thread", PICKER_CLIP);
  await picker.click();
  await expect
    .element(page.getByRole("tab", { name: DEFAULT_SET.name, exact: true }))
    .toHaveAttribute("aria-selected", "true");
  if (hasPrivateSetup) await shot("both-2-picker", PICKER_CLIP);
  await page.getByRole("tab", { name: OTHER_SET.name, exact: true }).click();
  await expect
    .element(page.getByRole("tab", { name: OTHER_SET.name, exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => {
    const picks = dispatchedCommands().filter(
      (command) => command.type === "thread.metadata.update" && command.skillSetId !== undefined,
    );
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ threadId: MAIN.id, skillSetId: OTHER_SET.id });
    expect(skillSetProviderRequests()).toContainEqual(
      expect.objectContaining({
        threadId: MAIN.id,
        cwd: expect.any(String),
        workspaceSnapshotsOnDemand: true,
      }),
    );
  });
  if (hasPrivateSetup) await shot("both-3-picker-pstack", PICKER_CLIP);
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("button", { name: `Skill set: ${OTHER_SET.name}` }))
    .toBeVisible();
  if (!hasPrivateSetup) await shot("example-thread");
});

it("keeps the skill and slash menus scoped to the picked thread", async () => {
  using _environment = install();
  const { screen, router } = await openThread(OTHERS[0]!.id);
  await using _app = screen;
  await page.getByRole("button", { name: `Skill set: ${DEFAULT_SET.name}` }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(OTHER_SET.name) }).click();
  await expect
    .element(page.getByRole("button", { name: `Skill set: ${OTHER_SET.name}` }))
    .toBeVisible();
  const skill = OTHER_SET.skills.find((skill) => skill.enabled);
  if (skill) {
    await page.getByTestId("composer-editor").fill(`$${skill.name}`);
    await expect
      .element(page.getByRole("option", { name: new RegExp(`^(?:/skill:)?${skill.name} `) }))
      .toBeVisible();
    await page.getByTestId("composer-editor").fill(`/${skill.name}`);
    await expect
      .element(page.getByRole("option", { name: new RegExp(`^(?:/skill:)?${skill.name} `) }))
      .toBeVisible();
    await page.getByTestId("composer-editor").fill("");
  }
  await act(() => router.navigate({ to: `/${ENVIRONMENT_ID}/${OTHERS[1]!.id}` as never }));
  await expect
    .element(page.getByRole("button", { name: `Skill set: ${DEFAULT_SET.name}` }))
    .toBeVisible();
});

it.each([
  { name: "settings-1-list", set: null },
  { name: "settings-2-pstack", set: OTHER_SET },
  { name: "settings-3-daniel", set: DEFAULT_SET },
])("captures $name", async ({ name, set }) => {
  using _clock = clock();
  using _environment = install();
  const { screen, router } = await openThread();
  await using _app = screen;
  await act(() => router.navigate({ to: "/settings/skill-sets" as never }));
  await expect
    .element(page.getByRole("button", { name: `${OTHER_SET.name} details` }))
    .toBeVisible();
  if (set) await page.getByRole("button", { name: `${set.name} details` }).click();
  if (hasPrivateSetup) await shot(name, SETTINGS_CLIP);
});

it("saves settings switches, disabled skills, registration and interval", async () => {
  using _clock = clock();
  using _environment = install();
  const { screen, router } = await openThread();
  await using _app = screen;
  await act(() => router.navigate({ to: "/settings/skill-sets" as never }));
  const otherDetails = page.getByRole("button", { name: `${OTHER_SET.name} details` });
  await expect.element(otherDetails).toBeVisible();
  await otherDetails.click();
  await page.getByRole("switch", { name: `Enable ${OTHER_SET.name}`, exact: true }).click();
  await vi.waitFor(() =>
    expect(skillSetSettingsPatches()).toContainEqual({
      skillSets: { [OTHER_SET.id]: { ...configs[OTHER_SET.id], enabled: false } },
    }),
  );
  await page.getByRole("switch", { name: `Default ${OTHER_SET.name}`, exact: true }).click();
  await vi.waitFor(() =>
    expect(skillSetSettingsPatches()).toContainEqual({ defaultSkillSetId: OTHER_SET.id }),
  );
  const firstSkill = OTHER_SET.skills[0];
  if (firstSkill) {
    await page.getByRole("switch", { name: `Load ${firstSkill.name}`, exact: true }).click();
    await vi.waitFor(() =>
      expect(
        skillSetSettingsPatches().some(
          (patch) =>
            patch.skillSets?.[OTHER_SET.id]?.disabledSkills.includes(firstSkill.name) ===
            firstSkill.enabled,
        ),
      ).toBe(true),
    );
  }
  await page.getByRole("spinbutton", { name: "Sync interval in minutes" }).fill("11");
  await userEvent.tab();
  await vi.waitFor(() =>
    expect(skillSetSettingsPatches()).toContainEqual({ skillSetSyncIntervalMinutes: 11 }),
  );
  await otherDetails.click();
  await page.getByRole("button", { name: `${DEFAULT_SET.name} details` }).click();
  await page.getByRole("textbox", { name: "New skill set name" }).fill("New Kit");
  await page.getByRole("textbox", { name: "Git URL or local folder" }).fill("invalid");
  await page.getByRole("button", { name: "Register skill set" }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Git URL or local folder" })
    .fill("https://github.com/example/new-kit");
  await page.getByRole("button", { name: "Register skill set" }).click();
  await expect.element(page.getByRole("button", { name: "New Kit details" })).toBeVisible();
  await page.getByRole("switch", { name: "Enable skill sets", exact: true }).click();
  await vi.waitFor(() =>
    expect(skillSetSettingsPatches()).toContainEqual({ skillSetsEnabled: false }),
  );
});

it.each([
  { name: "master off", enabled: false, setsEnabled: true },
  { name: "no enabled sets", enabled: true, setsEnabled: false },
])("renders upstream composer and picker with $name", async ({ enabled, setsEnabled }) => {
  using _environment = install(enabled, setsEnabled);
  const { screen } = await openThread();
  await using _app = screen;
  await expect.element(page.getByRole("button", { name: /^Skill set:/ })).not.toBeInTheDocument();
  await page
    .getByRole("button", { name: hasPrivateSetup ? /Fable 5\.2/ : /GPT-5\.4/i })
    .first()
    .click();
  await expect.element(page.getByRole("tablist", { name: "Skill sets" })).not.toBeInTheDocument();
});

it("fixes provider-native child controls to their parent's pick", async () => {
  const parent = { ...prototypeThread("native-owner", "Native owner"), skillSetId: DEFAULT_SET.id };
  const child = {
    ...prototypeThread("native-child", "Native child"),
    providerSubagentOf: parent.id,
    skillSetId: OTHER_SET.id,
  };
  using _environment = install(true, true, [parent, child]);
  const { screen } = await mountApp(`/${ENVIRONMENT_ID}/${child.id}`);
  await using _app = screen;
  await expect.element(page.getByText("Native child", { exact: true }).first()).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: `Skill set: ${DEFAULT_SET.name}` }))
    .toBeDisabled();
});

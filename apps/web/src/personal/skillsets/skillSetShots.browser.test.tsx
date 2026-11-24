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
import {
  hasPrivateSetup,
  setActiveSkillSet,
  setSkillSetVariant,
  setup,
  type SkillSetVariant,
} from "./skillSetsStore";

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
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-2",
  options: [{ id: "effort", value: "high" }],
};

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

const MAIN = prototypeThread("thread-skill-sets", setup.thread.title);
const OTHERS = setup.thread.otherTitles.map((title, index) => ({
  ...threadWithHistory(`thread-other-${index}`, 1, MODEL),
  title,
}));

const [firstProject, ...otherProjects] = setup.projects;

function install() {
  return installFakeEnvironment([...OTHERS, MAIN], {
    acceptCommands: true,
    providers: setup.providers,
    settings: { providerInstances: setup.providerInstances },
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

async function openThread() {
  await page.viewport(1400, 900);
  using _environment = install();
  const app = await mountApp(`/${ENVIRONMENT_ID}/${MAIN.id}`);
  await expect.element(page.getByText(LAST_ANSWER_START)).toBeVisible();
  await document.fonts.ready;
  return app;
}

const VARIANTS: ReadonlyArray<SkillSetVariant> = ["off", "tabs", "rail", "chip", "both"];

it.skipIf(!hasPrivateSetup).each(VARIANTS)("shots: %s", async (variant) => {
  using _clock = clock();
  setSkillSetVariant(variant);
  setActiveSkillSet(DEFAULT_SET.id);
  const { screen, router } = await openThread();
  await using _app = screen;
  const label = variant === "off" ? "before" : variant;

  await shot(`${label}-1-thread`, PICKER_CLIP);
  if (variant === "chip") {
    await page.getByRole("button", { name: /Skill set:/ }).click();
    await expect.element(page.getByRole("menuitem", { name: "Manage skill sets" })).toBeVisible();
  } else {
    await page
      .getByRole("button", { name: /Fable 5\.2/ })
      .first()
      .click();
    await expect.element(page.getByPlaceholder("Search models...")).toBeVisible();
  }
  await shot(`${label}-2-picker`, PICKER_CLIP);
  if (variant === "tabs" || variant === "rail" || variant === "both") {
    // The same picker with another set chosen, to show the selected state move.
    await page
      .getByRole(variant === "rail" ? "button" : "tab", { name: new RegExp(OTHER_SET.name) })
      .click();
    await shot(`${label}-3-picker-${OTHER_SET.id}`, PICKER_CLIP);
  }
  await userEvent.keyboard("{Escape}");

  if (variant === "off") {
    await act(() => router.navigate({ to: "/settings/providers" }));
    await shot("before-3-settings", SETTINGS_CLIP);
  }
});

it.skipIf(!hasPrivateSetup)("shots: settings", async () => {
  using _clock = clock();
  setSkillSetVariant("tabs");
  setActiveSkillSet(DEFAULT_SET.id);
  const { screen, router } = await openThread();
  await using _app = screen;
  const otherDetails = page.getByRole("button", { name: `${OTHER_SET.name} details` });
  await act(() => router.navigate({ to: "/settings/skill-sets" as never }));
  await expect.element(otherDetails).toBeVisible();
  await shot("settings-1-list", SETTINGS_CLIP);
  await otherDetails.click();
  await shot(`settings-2-${OTHER_SET.id}`, SETTINGS_CLIP);
  await otherDetails.click();
  await page.getByRole("button", { name: `${DEFAULT_SET.name} details` }).click();
  await shot(`settings-3-${DEFAULT_SET.id}`, SETTINGS_CLIP);
});

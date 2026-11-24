# Skill sets (prototype)

A skill set is a git repo of agent skills. A thread picks one set, and only that set's skills load,
on any provider account. This folder is a UI prototype: it shows where a set is chosen and how a
repo is registered. It does not load skills yet.

## What is here

| File                             | What it is                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `SkillSetPickers.tsx`            | The placements for choosing a set: tabs on the model picker, a second rail, a composer chip |
| `SkillSetsSettings.tsx`          | Settings -> Skill sets: register a repo, logo, auto-sync, per-skill switches                |
| `skillSetsStore.ts`              | Prototype state: the registered sets, the active set, which placement shows                 |
| `skillSetShots.browser.test.tsx` | Mounts the whole app headlessly and saves a screenshot per placement                        |
| `setup.fixture.json`             | Not in git. One user's real setup, built by a script outside this repo                      |
| `setup.fixture.example.json`     | Neutral data of the same shape; the store uses it when `setup.fixture.json` is missing      |

## Where it touches upstream files

A few one-line seams, so a rebase onto upstream has little to redo:

- `components/chat/ProviderModelPicker.tsx`: the tabs and the rail
- `components/chat/ComposerFooterControls.tsx`: the composer chip
- `components/settings/settingsSearch.ts` and `SettingsSidebarNav.tsx`: the Settings entry
- `routes/_chat.settings.skill-sets.tsx`: the Settings route (new file)

`test/fakeEnvironment.ts` gained three options the screenshots need: server settings, a project
per thread, and a machine label.

## Run the screenshots

Every seam is listed in `personal/skill-sets.seams.json` at the repo root, and each one carries the
comment `personal:skill-sets seam`.

`setup.fixture.json` must exist first; without it the screenshot tests are skipped. Then, from
`apps/web`:

```
vp test run --project browser src/personal/skillsets/skillSetShots.browser.test.tsx
```

Screenshots land in `apps/web/.proto-shots`.

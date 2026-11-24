# Skill sets

The approved picker uses tabs in the model picker and a composer control. Both edit the current thread's durable pick; new threads keep the pick in their persisted draft until launch. With the master switch off, both controls disappear.

The registry comes from environment server settings. Status and skill inventories come from the environment status stream. Thread menu catalogs stay keyed by thread and selection rather than entering the shared provider cache.

Run the browser proof from `apps/web`:

```
vp test run --project browser src/personal/skillsets/skillSetShots.browser.test.tsx
```

Assertions run against the tracked neutral example. An optional ignored `setup.fixture.json` supplies private screenshot data; it is test-only and never loaded by production code. The six approved captures are written to `apps/web/.proto-shots` when it is present.

Upstream integration points are recorded in `personal/skill-sets.seams.json`.

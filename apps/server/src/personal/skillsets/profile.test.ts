// @effect-diagnostics nodeBuiltinImport:off -- Profile folders are real folders on disk.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { AgentProfileProvider } from "@t3tools/contracts";
import { readMachineInventory } from "./inventory.ts";
import {
  MACHINE_POLICY_HOOKS_OFF_ENV,
  machinePolicyHooksEnvironment,
  profileItems,
  profileView,
  readProfileFolder,
  resolveAgentProfile,
  type ProfileOverlay,
} from "./profile.ts";
import { scanSkills } from "./sync.ts";
import { hashTree, makeFakeMachine, write } from "./testFakeMachine.ts";

async function folder(files: Record<string, string> = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "profile-"));
  for (const [path, contents] of Object.entries(files))
    await write(NodePath.join(root, path), contents);
  return root;
}
async function resolveAll(
  root: string,
  overlay: ProfileOverlay = { disabledSkills: [] },
  inventory?: Awaited<ReturnType<typeof readMachineInventory>>,
) {
  const result = profileItems({
    folder: await readProfileFolder(root),
    skills: await scanSkills(root),
    overlay,
    inventory,
  });
  const resolve = (provider: AgentProfileProvider) =>
    resolveAgentProfile({
      profileId: "alpha",
      provider,
      root,
      items: result.items,
      ignoreProjectInstructions: false,
    });
  return {
    ...result,
    claude: resolve("claude"),
    codex: resolve("codex"),
    antigravity: resolve("antigravity"),
  };
}
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n`;
const hooks = (command: string) =>
  JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });

describe("agent profile model", () => {
  it("reads an empty folder as the stock agent and a skill set as a Skills-only profile", async () => {
    const empty = await resolveAll(await folder());
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      expect(empty[provider]).toMatchObject({
        instructions: null,
        skills: [],
        plugins: [],
        hooks: [],
        hooksFile: null,
        mcpServers: {},
      });
    }
    const set = await resolveAll(await folder({ "skills/alpha/SKILL.md": skill("alpha") }));
    expect(set.items.map((item) => item.id)).toEqual(["skill:alpha"]);
    expect(set.codex).toMatchObject({ instructions: null, plugins: [], hooksFile: null });
    expect(set.codex.skills.map((entry) => entry.name)).toEqual(["alpha"]);
  });

  it("gives each provider its own parts from the profile folder layout", async () => {
    const root = await folder({
      "instructions.md": "shared rules",
      "CLAUDE.md": "claude rules",
      "skills/alpha/SKILL.md": skill("alpha"),
      "plugins.json": JSON.stringify({ claude: ["review@market"], codex: ["browser@bundled"] }),
      "hooks/claude.json": hooks("node claude-stop.mjs"),
      "hooks/antigravity.json": JSON.stringify({
        guard: { PreToolUse: [{ matcher: "run_command", hooks: [{ command: "node g.mjs" }] }] },
      }),
      "mcp.json": JSON.stringify({ mcpServers: { docs: { url: "https://docs.example/mcp" } } }),
    });
    const profile = await resolveAll(root);
    expect(profile.claude.instructions?.text).toBe("claude rules");
    expect(profile.codex.instructions?.text).toBe("shared rules");
    expect(profile.claude.plugins).toEqual(["review@market"]);
    expect(profile.codex.plugins).toEqual(["browser@bundled"]);
    expect(profile.antigravity.plugins).toEqual([]);
    expect(profile.claude.hooksFile).toEqual(JSON.parse(hooks("node claude-stop.mjs")).hooks);
    expect(profile.codex.hooksFile).toBeNull();
    expect(profile.antigravity.hooksFile).toEqual({
      guard: { PreToolUse: [{ matcher: "run_command", hooks: [{ command: "node g.mjs" }] }] },
    });
    for (const provider of ["claude", "codex", "antigravity"] as const)
      expect(profile[provider].mcpServers).toEqual({ docs: { url: "https://docs.example/mcp" } });
  });

  it("switches single items off through the overlay and changes the content hash", async () => {
    const root = await folder({
      "instructions.md": "shared rules",
      "CLAUDE.md": "claude rules",
      "skills/alpha/SKILL.md": skill("alpha"),
      "skills/beta/SKILL.md": skill("beta"),
      "hooks/claude.json": hooks("node claude-stop.mjs"),
      "mcp.json": JSON.stringify({ mcpServers: { docs: { url: "https://docs.example/mcp" } } }),
    });
    const before = await resolveAll(root);
    const after = await resolveAll(root, {
      disabledSkills: ["beta"],
      disabledItems: ["instructions:CLAUDE.md", "hook:claude:Stop:0", "mcp:docs"],
    });
    expect(after.claude.instructions?.text).toBe("shared rules");
    expect(after.claude.skills.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(after.claude.hooksFile).toBeNull();
    expect(after.claude.mcpServers).toEqual({});
    expect(after.items.filter((item) => !item.enabled).map((item) => item.id)).toEqual([
      "instructions:CLAUDE.md",
      "skill:beta",
      "hook:claude:Stop:0",
      "mcp:docs",
    ]);
    expect(after.claude.contentHash).not.toBe(before.claude.contentHash);
    expect((await resolveAll(root)).claude.contentHash).toBe(before.claude.contentHash);
  });

  it("resolves references to the real setup at build time without copying secrets into the folder", async () => {
    const machine = await makeFakeMachine();
    const references = [
      "claude:instructions:CLAUDE.md",
      "claude:skill:alpha",
      "claude:mcp:calendar",
      "codex:hook:PreToolUse:0",
      "codex:plugin:browser@bundled",
      "codex:hook:policy:hooks.json:PreToolUse:0",
      "claude:mcp:absent",
    ];
    const root = await folder({
      "refs.json": JSON.stringify(references.map((ref) => ({ ref }))),
    });
    const machineBefore = await hashTree(machine.root);
    let profile = await resolveAll(
      root,
      { disabledSkills: [] },
      await readMachineInventory(machine.paths),
    );
    expect(profile.claude.instructions?.text).toBe("claude rules");
    expect(profile.codex.instructions).toBeNull();
    expect(profile.antigravity.skills.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(profile.codex.mcpServers.calendar?.env).toEqual({ TOKEN: "s3cret" });
    expect(profile.codex.hooksFile).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node codex-guard.mjs" }] },
        ],
      },
    });
    expect(profile.codex.plugins).toEqual(["browser@bundled"]);
    expect(profile.claude.hooksFile).toBeNull();
    expect(profile.errors).toEqual(["Reference claude:mcp:absent was not found on this machine"]);
    // A referenced machine-policy hook stays on; the machine runs it, so it is not copied.
    expect(profile.codex.machinePolicyHooksOff).toEqual([]);
    expect(profile.claude.machinePolicyHooksOff.map((hook) => hook.id)).toEqual([
      "claude:hook:policy:policy.json:PreToolUse:0",
    ]);
    const view = profileView({
      id: "alpha",
      name: "Alpha",
      root,
      ignoreProjectInstructions: false,
      items: profile.items,
      errors: profile.errors,
    });
    expect(JSON.stringify(view)).not.toContain("s3cret");
    expect(view.items.find((item) => item.id === "ref:claude:mcp:absent")).toMatchObject({
      missing: true,
      enabled: false,
    });
    for (const file of Object.keys(await hashTree(root)))
      expect(await NodeFSP.readFile(file, "utf8")).not.toContain("s3cret");
    expect(await hashTree(machine.root)).toEqual(machineBefore);

    await NodeFSP.writeFile(NodePath.join(machine.paths.claudeHome, "CLAUDE.md"), "edited rules");
    profile = await resolveAll(
      root,
      { disabledSkills: [] },
      await readMachineInventory(machine.paths),
    );
    expect(profile.claude.instructions?.text).toBe("edited rules");
  });

  it("lists machine-policy hooks as switches that are off in an empty profile", async () => {
    const machine = await makeFakeMachine();
    const inventory = await readMachineInventory(machine.paths);
    const root = await folder();
    const empty = await resolveAll(root, { disabledSkills: [] }, inventory);
    expect(empty.items.map((item) => `${item.id}:${item.enabled}`)).toEqual([
      "policy:claude:hook:policy:policy.json:PreToolUse:0:false",
      "policy:codex:hook:policy:hooks.json:PreToolUse:0:false",
    ]);
    expect(empty.codex.machinePolicyHooksOff).toEqual([
      {
        id: "codex:hook:policy:hooks.json:PreToolUse:0",
        file: machine.paths.codexPolicy[0],
        event: "PreToolUse",
        matcher: "Bash",
        commands: ["node machine-guard.mjs"],
      },
    ]);
    expect(empty.codex.hooksFile).toBeNull();
    expect(empty.antigravity.machinePolicyHooksOff).toEqual([]);
    expect(
      JSON.parse(machinePolicyHooksEnvironment(empty.codex)[MACHINE_POLICY_HOOKS_OFF_ENV]),
    ).toEqual(empty.codex.machinePolicyHooksOff);
    const on = await resolveAll(
      root,
      { disabledSkills: [], enabledItems: ["policy:codex:hook:policy:hooks.json:PreToolUse:0"] },
      inventory,
    );
    expect(on.codex.machinePolicyHooksOff).toEqual([]);
    expect(on.codex.hooksFile).toBeNull();
    expect(on.codex.contentHash).not.toBe(empty.codex.contentHash);
    expect(machinePolicyHooksEnvironment(on.codex)).toEqual({
      [MACHINE_POLICY_HOOKS_OFF_ENV]: "[]",
    });
  });

  it("lets the profile's own file win over a reference for the same provider", async () => {
    const machine = await makeFakeMachine();
    const root = await folder({
      "CLAUDE.md": "profile rules",
      "refs.json": JSON.stringify([{ ref: "claude:instructions:CLAUDE.md" }]),
    });
    const inventory = await readMachineInventory(machine.paths);
    expect(
      (await resolveAll(root, { disabledSkills: [] }, inventory)).claude.instructions?.text,
    ).toBe("profile rules");
    expect(
      (
        await resolveAll(
          root,
          { disabledSkills: [], disabledItems: ["instructions:CLAUDE.md"] },
          inventory,
        )
      ).claude.instructions?.text,
    ).toBe("claude rules");
  });
});

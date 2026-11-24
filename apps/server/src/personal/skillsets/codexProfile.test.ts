// @effect-diagnostics nodeBuiltinImport:off -- Pure path fixtures for pure functions.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import {
  codexIgnoreProjectConfig,
  codexOwnedEntries,
  codexProfileConfigEdits,
  codexProfileDisablesHooks,
  codexUntrustedProjectsArg,
  type CodexHookListing,
} from "./codexProfile.ts";
import type { ResolvedAgentProfile } from "./profile.ts";

const realHome = NodePath.resolve("/fixture/user/.codex");
const homePath = NodePath.resolve("/fixture/state/homes/alpha");
const repo = NodePath.resolve("/fixture/repo");

function profileOf(parts: Partial<ResolvedAgentProfile> = {}): ResolvedAgentProfile {
  return {
    profileId: "alpha",
    provider: "codex",
    root: NodePath.resolve("/fixture/profile"),
    ignoreProjectInstructions: false,
    instructions: null,
    skills: [],
    plugins: [],
    hooks: [],
    hooksFile: null,
    machinePolicyHooksOff: [],
    mcpServers: {},
    contentHash: "hash-alpha",
    ...parts,
  };
}

const hook = (parts: Partial<CodexHookListing>): CodexHookListing => ({
  key: `${NodePath.join(homePath, "hooks.json")}:session_start:0:0`,
  source: "user",
  sourcePath: NodePath.join(homePath, "hooks.json"),
  currentHash: "sha256:profile",
  command: "node profile-hook.mjs",
  enabled: true,
  trustStatus: "untrusted",
  ...parts,
});
const policyHook = hook({
  key: "C:\\ProgramData\\OpenAI\\Codex\\hooks.json:pre_tool_use:0:0",
  source: "system",
  sourcePath: "C:\\ProgramData\\OpenAI\\Codex\\hooks.json",
  command: "node outside-post-guard.mjs",
  trustStatus: "managed",
});
const edit = (edits: ReturnType<typeof codexProfileConfigEdits>, keyPath: string) =>
  edits.find((entry) => entry.keyPath === keyPath);

describe("Codex profile home", () => {
  it("leaves every profile file out of an empty profile and copies the real config bytes", () => {
    const real = 'model = "fixture"\r\n[mcp_servers.personal]\ncommand = "node"\n';
    expect(codexOwnedEntries(profileOf(), real)).toEqual({
      "AGENTS.md": null,
      "AGENTS.override.md": null,
      "hooks.json": null,
      "config.toml": { kind: "file", contents: real },
    });
    expect(codexOwnedEntries(profileOf(), null)["config.toml"]).toEqual({
      kind: "file",
      contents: "",
    });
  });

  it("writes the profile's own instructions and hook file", () => {
    const hooksFile = { hooks: { SessionStart: [{ hooks: [{ command: "node hook.mjs" }] }] } };
    const owned = codexOwnedEntries(
      profileOf({
        instructions: { itemId: "instructions:AGENTS.md", path: "unused", text: "PROFILE-MARKER" },
        hooksFile,
      }),
      "",
    );
    expect(owned["AGENTS.md"]).toEqual({ kind: "file", contents: "PROFILE-MARKER" });
    expect(JSON.parse((owned["hooks.json"] as { contents: string }).contents)).toEqual(hooksFile);
  });
});

describe("Codex profile config edits", () => {
  it("replaces MCP servers, plugins, the skill disable list, hook trust and notify", () => {
    const edits = codexProfileConfigEdits({
      profile: profileOf({
        plugins: ["alpha-plugin@market"],
        mcpServers: {
          stdio: { type: "stdio", command: "node", args: ["server.mjs"], env: { TOKEN: "x" } },
          remote: { type: "http", url: "https://example.test/mcp", headers: { A: "b" } },
        },
        hooks: [{ path: ["notify"], index: 0, group: ["notify.exe", "turn-ended"], itemId: "n" }],
        hooksFile: { hooks: {} },
      }),
      realHome,
      homePath,
      skillRules: [
        { path: NodePath.resolve("/os-home/.agents/skills/extra/SKILL.md"), enabled: false },
      ],
      hooks: [
        hook({}),
        hook({
          key: `${NodePath.join(repo, ".codex", "hooks.json")}:session_start:0:0`,
          source: "project",
          sourcePath: NodePath.join(repo, ".codex", "hooks.json"),
          currentHash: "sha256:repo",
        }),
        policyHook,
      ],
      hooksState: {
        [`${NodePath.join(realHome, "hooks.json")}:session_start:0:0`]: {
          trusted_hash: "sha256:real",
        },
        [`${NodePath.join(repo, ".codex", "hooks.json")}:session_start:0:0`]: {
          trusted_hash: "sha256:repo",
        },
      },
    });
    expect(edits.every((entry) => entry.mergeStrategy === "replace")).toBe(true);
    expect(edit(edits, "mcp_servers")?.value).toEqual({
      stdio: { command: "node", args: ["server.mjs"], env: { TOKEN: "x" } },
      remote: { url: "https://example.test/mcp", http_headers: { A: "b" } },
    });
    expect(edit(edits, "plugins")?.value).toEqual({ "alpha-plugin@market": { enabled: true } });
    expect(edit(edits, "skills.config")?.value).toEqual([
      { path: NodePath.resolve("/os-home/.agents/skills/extra/SKILL.md"), enabled: false },
    ]);
    // The profile's hooks are trusted; a trusted project hook stays trusted; the real home's row goes.
    expect(edit(edits, "hooks")?.value).toEqual({
      state: {
        [`${NodePath.join(homePath, "hooks.json")}:session_start:0:0`]: {
          trusted_hash: "sha256:profile",
        },
        [`${NodePath.join(repo, ".codex", "hooks.json")}:session_start:0:0`]: {
          trusted_hash: "sha256:repo",
        },
      },
    });
    expect(edit(edits, "notify")?.value).toEqual(["notify.exe", "turn-ended"]);
  });

  it("switches off ChatGPT apps and remote plugins and keeps bundled plugins in every profile", () => {
    const edits = codexProfileConfigEdits({
      profile: profileOf({ plugins: ["alpha@market"] }),
      realHome,
      homePath,
      skillRules: [],
      hooks: [],
      hooksState: undefined,
      userPlugins: {
        "visualize@openai-bundled": { enabled: true },
        "personal@market": { enabled: true },
      },
    });
    expect(edit(edits, "features.apps")?.value).toBe(false);
    expect(edit(edits, "features.remote_plugin")?.value).toBe(false);
    expect(edit(edits, "plugins")?.value).toEqual({
      "visualize@openai-bundled": { enabled: true },
      "alpha@market": { enabled: true },
    });
  });

  it("removes every profile-owned key for an empty profile", () => {
    const edits = codexProfileConfigEdits({
      profile: profileOf(),
      realHome,
      homePath,
      skillRules: [],
      hooks: [policyHook],
      hooksState: {
        [`${NodePath.join(realHome, "hooks.json")}:session_start:0:0`]: { trusted_hash: "x" },
      },
    });
    for (const key of ["mcp_servers", "plugins", "skills.config", "hooks", "notify"])
      expect(edit(edits, key)?.value).toBeNull();
  });

  it("trusts a plugin hook of a profile plugin only when the real config trusted the same content", () => {
    const pluginHook = (pluginId: string, currentHash: string) =>
      hook({
        key: `${homePath}\\plugins\\cache\\${pluginId}\\hooks.json:stop:0:0`,
        source: "plugin",
        pluginId,
        currentHash,
      });
    const edits = codexProfileConfigEdits({
      profile: profileOf({ plugins: ["alpha@market", "beta@market"] }),
      realHome,
      homePath,
      skillRules: [],
      hooks: [
        pluginHook("alpha@market", "sha256:trusted"),
        pluginHook("beta@market", "sha256:never-trusted"),
        pluginHook("gamma@market", "sha256:trusted"),
      ],
      hooksState: {
        [`${realHome}\\plugins\\alpha\\hooks.json:stop:0:0`]: { trusted_hash: "sha256:trusted" },
      },
    });
    const hooks = edit(edits, "hooks")?.value as { state: Record<string, unknown> } | undefined;
    expect(Object.keys(hooks?.state ?? {})).toEqual([
      `${realHome}\\plugins\\alpha\\hooks.json:stop:0:0`,
      `${homePath}\\plugins\\cache\\alpha@market\\hooks.json:stop:0:0`,
    ]);
  });
});

describe("Codex --disable hooks", () => {
  const off = (command: string) => ({
    id: "policy",
    file: "hooks.json",
    event: "PreToolUse",
    commands: [command],
  });
  it("switches every hook off for a profile with no hooks and the machine-policy hooks off", () => {
    expect(
      codexProfileDisablesHooks(
        profileOf({ machinePolicyHooksOff: [off("node outside-post-guard.mjs")] }),
        [policyHook],
      ),
    ).toBe(true);
    expect(codexProfileDisablesHooks(profileOf(), [])).toBe(true);
  });
  it("keeps hooks on when the profile, a profile plugin, a trusted project hook or a switched-on policy hook needs them", () => {
    const allOff = { machinePolicyHooksOff: [off("node outside-post-guard.mjs")] };
    expect(codexProfileDisablesHooks(profileOf({ ...allOff, hooksFile: { hooks: {} } }), [])).toBe(
      false,
    );
    expect(codexProfileDisablesHooks(profileOf(), [policyHook])).toBe(false);
    expect(
      codexProfileDisablesHooks(profileOf({ ...allOff, plugins: ["alpha@market"] }), [
        policyHook,
        hook({ source: "plugin", pluginId: "alpha@market" }),
      ]),
    ).toBe(false);
    expect(
      codexProfileDisablesHooks(profileOf(allOff), [
        policyHook,
        hook({ source: "plugin", pluginId: "other@market" }),
      ]),
    ).toBe(true);
    expect(
      codexProfileDisablesHooks(profileOf(allOff), [
        policyHook,
        hook({ source: "project", trustStatus: "trusted" }),
      ]),
    ).toBe(false);
    expect(
      codexProfileDisablesHooks(profileOf(allOff), [
        policyHook,
        hook({ source: "project", trustStatus: "untrusted" }),
      ]),
    ).toBe(true);
  });
});

describe("Codex ignore-project thread config", () => {
  it("drops repo instructions, repo skills, project MCP servers and project hooks", () => {
    const skill = NodePath.join(repo, ".agents", "skills", "repo-skill", "SKILL.md");
    const hookKey = `${NodePath.join(repo, ".codex", "hooks.json")}:session_start:0:0`;
    expect(
      codexIgnoreProjectConfig({
        repoSkillPaths: [skill],
        projectMcpServers: ["repo-mcp"],
        projectHookKeys: [hookKey],
      }),
    ).toEqual({
      project_doc_max_bytes: 0,
      "skills.config": [{ path: skill, enabled: false }],
      "mcp_servers.repo-mcp.enabled": false,
      hooks: { state: { [hookKey]: { enabled: false } } },
    });
    expect(
      codexIgnoreProjectConfig({ repoSkillPaths: [], projectMcpServers: [], projectHookKeys: [] }),
    ).toEqual({ project_doc_max_bytes: 0 });
  });

  it("puts back the user value of every key the repo config sets", () => {
    expect(
      codexIgnoreProjectConfig({
        repoSkillPaths: [],
        projectMcpServers: [],
        projectHookKeys: [],
        configOverrides: { developer_instructions: "", notify: ["user-notify"] },
      }),
    ).toEqual({ project_doc_max_bytes: 0, developer_instructions: "", notify: ["user-notify"] });
  });

  it("marks the project folders untrusted for the whole process in one quoted -c", () => {
    const arg = codexUntrustedProjectsArg([NodePath.join(repo, "sub"), repo]);
    expect(arg.startsWith('-c "projects={')).toBe(true);
    expect(arg).toContain('trust_level=\\"untrusted\\"');
    expect(arg.match(/untrusted/g)).toHaveLength(2);
    // The launch tokenizer hands Codex one TOML value with literal-string keys.
    expect(tokenizeCliArgs(arg)).toEqual([
      "-c",
      `projects={'${NodePath.join(repo, "sub")}'={trust_level="untrusted"},'${repo}'={trust_level="untrusted"}}`,
    ]);
    expect(codexUntrustedProjectsArg([])).toBe("");
  });
});

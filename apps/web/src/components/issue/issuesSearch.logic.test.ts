import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";

import {
  issueFilterProjects,
  issueHiddenProjects,
  issueListTargets,
  issuesSearchFromUrl,
  scopedEnvironmentIds,
  sidebarProjectScope,
} from "./issuesSearch.logic";

describe("issuesSearchFromUrl", () => {
  it("replaces a malformed filter instead of letting the raw value through", () => {
    // The router lays the validated keys over the raw search, so a key left out keeps its raw value.
    const raw = { label: true, order: "oldest", assignee: "   ", host: true };
    const search = { ...raw, ...issuesSearchFromUrl(raw) };
    expect(search.host).toBeUndefined();
    expect(search.label).toBeUndefined();
    expect(search.assignee).toBeUndefined();
    expect(search.order).toBeUndefined();
    expect(issuesSearchFromUrl({ label: "bug" }).label).toEqual(["bug"]);
    expect(issuesSearchFromUrl({ label: ["bug", " ui "], order: "created" })).toMatchObject({
      label: ["bug", "ui"],
      order: "created",
    });
    expect(
      issuesSearchFromUrl({ hideProjects: [["env", "web"], ["env"], "api", ["env", 3]] })
        .hideProjects,
    ).toEqual([
      ["env", "web"],
      ["env", "3"],
    ]);
  });
});

describe("issueListTargets", () => {
  it("leaves hidden projects out and skips an environment with every project hidden", () => {
    const laptop = EnvironmentId.make("laptop");
    const vps = EnvironmentId.make("vps");
    const projects = [
      { environmentId: laptop, id: ProjectId.make("web") },
      { environmentId: laptop, id: ProjectId.make("api") },
      { environmentId: vps, id: ProjectId.make("docs") },
    ];
    const input = { state: "open" } as const;
    const hidden = [
      [laptop, ProjectId.make("api")],
      [laptop, ProjectId.make("removed")],
      [vps, ProjectId.make("docs")],
    ] as const;
    expect(issueListTargets([laptop, vps], projects, hidden, input)).toEqual([
      { environmentId: laptop, input: { state: "open", excludeProjectIds: ["api"] } },
    ]);
    // Before the project list loads, the saved choice still leaves its projects out.
    expect(issueListTargets([laptop, vps], [], hidden, input)).toEqual([
      { environmentId: laptop, input: { state: "open", excludeProjectIds: ["api", "removed"] } },
      { environmentId: vps, input: { state: "open", excludeProjectIds: ["docs"] } },
    ]);
    expect(issueListTargets([laptop, vps], projects, undefined, input)).toEqual([
      { environmentId: laptop, input },
      { environmentId: vps, input },
    ]);
  });
});

describe("sidebarProjectScope", () => {
  it("narrows the issues page to the one project the sidebar is scoped to", () => {
    const laptop = EnvironmentId.make("laptop");
    const vps = EnvironmentId.make("vps");
    const project = (
      environmentId: EnvironmentId,
      id: string,
      repository: string,
      archivedAt: string | null = null,
    ) =>
      ({
        id: ProjectId.make(id),
        environmentId,
        title: repository,
        workspaceRoot: `/work/${id}`,
        repositoryIdentity: {
          canonicalKey: `github.com/acme/${repository}`,
          name: repository,
        },
        isScratch: false,
        archivedAt,
        pinnedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }) as unknown as EnvironmentProject;
    const projects = [
      project(laptop, "web", "web"),
      project(vps, "web-vps", "web"),
      project(laptop, "api", "api"),
      project(laptop, "old", "old", "2026-02-01T00:00:00.000Z"),
    ];
    const settings = {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    } as const;
    // The keys the sidebar stores are its own group keys.
    const keyOf = (repository: string) =>
      buildSidebarProjectSnapshots({
        projects,
        settings,
        groupScratchProjects: true,
        primaryEnvironmentId: null,
        resolveEnvironmentLabel: () => null,
      }).find((group) => group.repositoryIdentity?.name === repository)!.projectKey;

    const scopeOf = (keys: ReadonlyArray<string>, projectsKnown = true) =>
      sidebarProjectScope(projects, settings, keys, { projectsKnown, primaryEnvironmentId: vps });
    const label = (keys: ReadonlyArray<string>) => {
      const scope = scopeOf(keys);
      return typeof scope === "object" && scope !== null ? scope.label : scope;
    };

    const scope = scopeOf([keyOf("web")]);
    if (typeof scope !== "object" || scope === null) throw new Error("expected a scope");
    expect(scope.label).toBe("web");
    // The chip's icon is the project the sidebar shows for the group.
    expect(scope.project.id).toBe("web-vps");
    // Both clones of the repository stay; every other project is left out of the listing.
    const hidden = [[laptop, ProjectId.make("removed")]] as const;
    expect(issueHiddenProjects(hidden, projects, scope)).toEqual([
      [laptop, "removed"],
      [laptop, "api"],
      [laptop, "old"],
    ]);
    // Only machines that hold the project are asked for issues.
    const docs = EnvironmentId.make("docs");
    expect(scopedEnvironmentIds([laptop, vps, docs], scope)).toEqual([laptop, vps]);
    expect(scopedEnvironmentIds([laptop, vps, docs], null)).toEqual([laptop, vps, docs]);

    // Two projects, none, a project that is gone or archived: the page lists as it did.
    expect(scopeOf([keyOf("web"), keyOf("api")])).toBeNull();
    expect(scopeOf([])).toBeNull();
    expect(scopeOf(["github.com/acme/gone"])).toBeNull();
    expect(scopeOf([keyOf("old")])).toBeNull();
    // A gone project next to a live one leaves the sidebar on the live one, and the page too.
    expect(label([keyOf("api"), "github.com/acme/gone"])).toBe("api");
    expect(issueHiddenProjects(hidden, projects, null)).toBe(hidden);

    // Until every machine has sent its projects, a stored project may still arrive: one such
    // project waits instead of listing everything, and a second one is not read as a one-project
    // scope.
    expect(scopeOf(["github.com/acme/later"], false)).toBe("pending");
    expect(scopeOf([keyOf("api"), "github.com/acme/later"], false)).toBeNull();
    expect(label([keyOf("api")])).toBe("api");
  });
});

describe("issueFilterProjects", () => {
  it("keeps every project, scratch ones too, as its own choice", () => {
    const environmentId = EnvironmentId.make("env");
    const project = (id: string, isScratch = false) =>
      ({
        id: ProjectId.make(id),
        environmentId,
        title: "t3code",
        workspaceRoot: `/work/${id}`,
        repositoryIdentity: { canonicalKey: "github.com/pingdotgg/t3code" },
        isScratch,
      }) as unknown as EnvironmentProject;
    const choices = issueFilterProjects(
      [project("main"), project("worktree"), project("scratch", true)],
      new Map([[environmentId, "laptop"]]),
    );
    expect(choices.map((choice) => [choice.id, choice.title])).toEqual([
      ["main", "t3code · laptop · /work/main"],
      ["scratch", "t3code · laptop · /work/scratch"],
      ["worktree", "t3code · laptop · /work/worktree"],
    ]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";

import {
  issueFilterProjects,
  issueHiddenProjects,
  issueListTargets,
  issuesSearchFromUrl,
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

    const scope = sidebarProjectScope(projects, settings, [keyOf("web")]);
    expect(scope?.label).toBe("web");
    // Both clones of the repository stay; every other project is left out of the listing.
    const hidden = [[laptop, ProjectId.make("removed")]] as const;
    expect(issueHiddenProjects(hidden, projects, scope)).toEqual([
      [laptop, "removed"],
      [laptop, "api"],
      [laptop, "old"],
    ]);

    // Two projects, none, a project that is gone or archived: the page lists as it did.
    expect(sidebarProjectScope(projects, settings, [keyOf("web"), keyOf("api")])).toBeNull();
    expect(sidebarProjectScope(projects, settings, [])).toBeNull();
    expect(sidebarProjectScope(projects, settings, ["github.com/acme/gone"])).toBeNull();
    expect(sidebarProjectScope(projects, settings, [keyOf("old")])).toBeNull();
    // A gone project next to a live one leaves the sidebar on the live one, and the page too.
    expect(
      sidebarProjectScope(projects, settings, [keyOf("api"), "github.com/acme/gone"])?.label,
    ).toBe("api");
    expect(issueHiddenProjects(hidden, projects, null)).toBe(hidden);
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

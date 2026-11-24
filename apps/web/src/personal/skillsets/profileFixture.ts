import type { ProfileParts } from "./profileParts";

// profiles.fixture.json is one user's real profile parts and stays out of git, like
// setup.fixture.json. A clean checkout has only the neutral example; the private one wins.
const fixtures = import.meta.glob<Readonly<Record<string, ProfileParts>>>(
  "./profiles.fixture*.json",
  { eager: true, import: "default" },
);

export const profileParts =
  fixtures["./profiles.fixture.json"] ?? fixtures["./profiles.fixture.example.json"]!;

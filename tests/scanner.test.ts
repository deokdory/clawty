import { describe, test, expect } from "bun:test";
import { decodeProjectPath, discoverProjects } from "../scanner";

describe("decodeProjectPath", () => {
  test("decodes simple path", () => {
    expect(decodeProjectPath("-home-deokdory")).toBe("/home/deokdory");
  });

  test("decodes nested path", () => {
    expect(decodeProjectPath("-home-deokdory-claude")).toBe("/home/deokdory/claude");
  });

  test("decodes deep path", () => {
    expect(decodeProjectPath("-home-deokdory-claude-projects-myapp")).toBe("/home/deokdory/claude/projects/myapp");
  });
});

describe("discoverProjects", () => {
  test("returns array without crashing", async () => {
    const result = await discoverProjects();
    expect(Array.isArray(result)).toBe(true);
  });

  test("each project has required fields", async () => {
    const result = await discoverProjects();
    for (const project of result) {
      expect(typeof project.id).toBe("string");
      expect(typeof project.path).toBe("string");
      expect(typeof project.displayName).toBe("string");
      expect(typeof project.sessionCount).toBe("number");
    }
  });

  test("projects start with slash in path", async () => {
    const result = await discoverProjects();
    for (const project of result) {
      expect(project.path.startsWith("/")).toBe(true);
    }
  });
});

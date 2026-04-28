import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ProjectId } from "@t3tools/contracts";

import { resolveThreadWorkspaceCwd } from "./Utils.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);

describe("resolveThreadWorkspaceCwd", () => {
  it("prefers an existing worktree path", () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-worktree-existing-"));

    try {
      expect(
        resolveThreadWorkspaceCwd({
          thread: {
            projectId: asProjectId("project-1"),
            worktreePath,
          },
          projects: [
            {
              id: asProjectId("project-1"),
              workspaceRoot: "/tmp/project-root",
            },
          ],
        }),
      ).toBe(worktreePath);
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("falls back to the project workspace root when the worktree path is stale", () => {
    const missingWorktreePath = path.join(
      os.tmpdir(),
      `t3code-worktree-missing-${crypto.randomUUID()}`,
    );

    expect(
      resolveThreadWorkspaceCwd({
        thread: {
          projectId: asProjectId("project-1"),
          worktreePath: missingWorktreePath,
        },
        projects: [
          {
            id: asProjectId("project-1"),
            workspaceRoot: "/tmp/project-root",
          },
        ],
      }),
    ).toBe("/tmp/project-root");
  });
});

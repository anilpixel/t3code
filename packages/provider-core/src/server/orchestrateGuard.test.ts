// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  checkOrchestrateFilePaths,
  checkOrchestrateShellCommand,
  checkOrchestrateToolGuard,
  isPathWithinProtectedRoots,
} from "./orchestrateGuard.ts";

describe("orchestrateGuard", () => {
  it("blocks direct file writes inside protected workspace roots including via symlinks while allowing sandbox writes", () => {
    const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-orchestrate-guard-"));
    try {
      const repoDir = NodePath.join(tmpRoot, "repo-a");
      const sandboxDir = NodePath.join(tmpRoot, "orchestrator");
      NodeFS.mkdirSync(NodePath.join(repoDir, "src"), { recursive: true });
      NodeFS.mkdirSync(sandboxDir, { recursive: true });
      const symlinkPath = NodePath.join(sandboxDir, "linked-src");
      NodeFS.symlinkSync(NodePath.join(repoDir, "src"), symlinkPath);

      const protectedRoots = [repoDir];

      expect(isPathWithinProtectedRoots("MEMORY.md", sandboxDir, protectedRoots)).toBeNull();
      expect(
        checkOrchestrateFilePaths(
          ["MEMORY.md", "/tmp/scratch-note.md"],
          sandboxDir,
          protectedRoots,
        ),
      ).toBeNull();

      expect(isPathWithinProtectedRoots("src/index.ts", repoDir, protectedRoots)).toBe(repoDir);
      expect(isPathWithinProtectedRoots("linked-src/new-file.ts", sandboxDir, protectedRoots)).toBe(
        repoDir,
      );

      expect(
        checkOrchestrateToolGuard({
          toolName: "Edit",
          toolInput: { file_path: NodePath.join(repoDir, "src/index.ts") },
          cwd: sandboxDir,
          protectedWorkspaceRoots: protectedRoots,
          unattendedTurn: false,
        }),
      ).toContain(repoDir);

      expect(
        checkOrchestrateToolGuard({
          toolName: "apply_patch",
          toolInput: {
            patch: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch",
          },
          cwd: repoDir,
          protectedWorkspaceRoots: protectedRoots,
          unattendedTurn: false,
        }),
      ).toContain(repoDir);

      expect(
        checkOrchestrateToolGuard({
          toolName: "Write",
          toolInput: { file_path: NodePath.join(sandboxDir, "MEMORY.md"), content: "# Notes" },
          cwd: sandboxDir,
          protectedWorkspaceRoots: protectedRoots,
          unattendedTurn: true,
        }),
      ).toBeNull();
    } finally {
      NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("blocks mutating shell commands targeting protected repos while allowing inspection, linear, gh, and sandbox redirects", () => {
    const protectedRoots = ["/workspaces/app", "/workspaces/t3/worktrees"];
    const sandboxCwd = "/workspaces/t3/userdata/orchestrator";

    // Allowed read-only & CLI orchestration commands
    expect(
      checkOrchestrateShellCommand({
        command:
          "linear issue query --team UQO && gh pr list -R owner/app && git -C /workspaces/app status && git -C /workspaces/app diff HEAD~1",
        cwd: sandboxCwd,
        protectedWorkspaceRoots: protectedRoots,
        unattendedTurn: true,
      }),
    ).toBeNull();

    // Allowed write in orchestrator sandbox
    expect(
      checkOrchestrateShellCommand({
        command: 'printf "## Decision\\n" >> MEMORY.md',
        cwd: sandboxCwd,
        protectedWorkspaceRoots: protectedRoots,
        unattendedTurn: true,
      }),
    ).toBeNull();

    // Quoted text mentioning gh pr merge or > is not treated as an operator or command
    expect(
      checkOrchestrateShellCommand({
        command: 'linear issue comment UQO-2 --body "Run gh pr merge 42 > after review"',
        cwd: sandboxCwd,
        protectedWorkspaceRoots: protectedRoots,
        unattendedTurn: true,
      }),
    ).toBeNull();

    // Blocked shell redirections / in-place edits / git mutations inside protected root
    expect(
      checkOrchestrateShellCommand({
        command: "echo 'export const x = 1;' > /workspaces/app/src/x.ts",
        cwd: sandboxCwd,
        protectedWorkspaceRoots: protectedRoots,
        unattendedTurn: false,
      }),
    ).toContain("/workspaces/app");

    expect(
      checkOrchestrateShellCommand({
        command: "cd /workspaces/app && sed -i 's/foo/bar/g' src/index.ts",
        cwd: sandboxCwd,
        protectedWorkspaceRoots: protectedRoots,
        unattendedTurn: false,
      }),
    ).toContain("/workspaces/app");

    expect(
      checkOrchestrateShellCommand({
        command: 'git -C /workspaces/app commit -am "quick fix"',
        cwd: sandboxCwd,
        protectedWorkspaceRoots: protectedRoots,
        unattendedTurn: false,
      }),
    ).toContain("/workspaces/app");
  });

  it("blocks PR/MR merge commands only during unattended wakes", () => {
    const protectedRoots = ["/workspaces/app"];
    const sandboxCwd = "/workspaces/t3/userdata/orchestrator";

    for (const command of [
      "gh pr merge 42 --squash",
      "gh -R owner/app pr merge 42",
      "glab mr merge 12",
      "tea pr merge 9",
      "gh api repos/owner/app/pulls/42/merge -X PUT",
      'echo "$(gh pr merge 42)"',
    ]) {
      expect(
        checkOrchestrateShellCommand({
          command,
          cwd: sandboxCwd,
          protectedWorkspaceRoots: protectedRoots,
          unattendedTurn: true,
        }),
      ).toContain("unattended wakes");

      expect(
        checkOrchestrateShellCommand({
          command,
          cwd: sandboxCwd,
          protectedWorkspaceRoots: protectedRoots,
          unattendedTurn: false,
        }),
      ).toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { getPreferredNewWorktreeWorkspacePath, translateRepoPathToWorktree } from './worktreeWorkspace';

describe('getPreferredNewWorktreeWorkspacePath', () => {
  it('uses the matching workspace file inside the new worktree when the current workspace has one', () => {
    expect(getPreferredNewWorktreeWorkspacePath({
      repoRoot: '/repos/project',
      currentWorkspaceRoot: '/repos/project',
      currentWorkspaceFile: '/repos/project/project.code-workspace',
      worktreeRoot: '/repos/project-feature'
    })).toBe('/repos/project-feature/project.code-workspace');
  });

  it('uses the matching folder inside the new worktree for folder-based workspaces', () => {
    expect(getPreferredNewWorktreeWorkspacePath({
      repoRoot: '/repos/project',
      currentWorkspaceRoot: '/repos/project/packages/api',
      worktreeRoot: '/repos/project-feature'
    })).toBe('/repos/project-feature/packages/api');
  });

  it('falls back to the matching folder when the workspace file is outside the repo', () => {
    expect(getPreferredNewWorktreeWorkspacePath({
      repoRoot: '/repos/project',
      currentWorkspaceRoot: '/repos/project',
      currentWorkspaceFile: '/workspaces/project.code-workspace',
      worktreeRoot: '/repos/project-feature'
    })).toBe('/repos/project-feature');
  });
});

describe('translateRepoPathToWorktree', () => {
  it('does not translate paths outside the repo root', () => {
    expect(translateRepoPathToWorktree(
      '/repos/other/project.code-workspace',
      '/repos/project',
      '/repos/project-feature'
    )).toBeUndefined();
  });
});

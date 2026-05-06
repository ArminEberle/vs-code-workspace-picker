import * as path from 'path';

export interface NewWorktreeWorkspacePathInput {
  repoRoot: string;
  currentWorkspaceRoot: string;
  currentWorkspaceFile?: string;
  worktreeRoot: string;
}

export function getPreferredNewWorktreeWorkspacePath(input: NewWorktreeWorkspacePathInput): string {
  if (input.currentWorkspaceFile) {
    const workspaceFilePath = translateRepoPathToWorktree(
      input.currentWorkspaceFile,
      input.repoRoot,
      input.worktreeRoot
    );
    if (workspaceFilePath) {
      return workspaceFilePath;
    }
  }

  return translateRepoPathToWorktree(
    input.currentWorkspaceRoot,
    input.repoRoot,
    input.worktreeRoot
  ) ?? input.worktreeRoot;
}

export function translateRepoPathToWorktree(
  targetPath: string,
  repoRoot: string,
  worktreeRoot: string
): string | undefined {
  const relativePath = path.relative(path.resolve(repoRoot), path.resolve(targetPath));
  if (relativePath && (relativePath.startsWith('..') || path.isAbsolute(relativePath))) {
    return undefined;
  }

  return path.join(worktreeRoot, relativePath);
}

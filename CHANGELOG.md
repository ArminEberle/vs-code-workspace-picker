# Changelog

## Unreleased

- Add a Marketplace screenshot to the README
- Add a repo-only `DEVELOPING.md` with local development and release workflow documentation
- Add npm scripts for packaging and Marketplace publishing with `vsce`
- Add local Bash and Windows batch release helpers for version bumping and tag pushes
- Automate GitHub Releases and Visual Studio Marketplace publishing via GitHub Actions on version tags
- Tighten packaged extension contents with `.vscodeignore`

## 0.0.1

- Initial public release
- Sidebar-based workspace picker
- Add folders and `.code-workspace` files to a persistent known-workspaces list
- Open known workspaces in the current window or a new window
- Reorder entries by dragging
- Show Git repository, branch, staged count, and unstaged count
- Create new Git worktrees from inside VS Code
- Support mixed Windows and WSL workspace setups
- Open WSL workspaces from a normal Windows VS Code session
- Remove entries from the list or delete removable worktrees/folders from disk

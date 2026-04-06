# Workspace Picker

Workspace Picker is an opinionated VS Code extension for people who bounce between many folders, repositories, and `.code-workspace` files and want a faster way to reopen them.

It adds a dedicated sidebar where you can keep a list of known workspaces, open them again quickly, inspect the current Git repo and branch for each entry, and create new Git worktrees without leaving VS Code.

This project is completely vibe-coded.

## What It Is For

This extension is meant for setups like:

- many local repositories on one machine
- a mix of plain folders and `.code-workspace` files
- switching between Windows and WSL workspaces
- creating feature branches as separate Git worktrees

Instead of relying only on `Open Recent`, Workspace Picker gives you a persistent, curated list of workspaces you actually care about.

## Features

- Sidebar-based workspace launcher
- Add a folder or `.code-workspace` file to the known list
- Add the current folder or workspace with one click
- Open a known entry in the current window or a new window
- Drag entries to reorder them in the sidebar
- Remove one or many entries from the list
- Show Git repository and branch information for listed entries when available
- Create a new Git worktree from the current repository
- Pick the base branch for a new worktree from local branches and remote branches including `origin/...`
- Store the workspace list in a way that can be shared between Windows and WSL when possible
- Open WSL workspaces directly from a normal Windows VS Code session

## How It Works

The extension lives in its own Activity Bar entry and opens a custom sidebar view.

From that sidebar you can:

- `Add New`: add folders or `.code-workspace` files manually
- `Add New Worktree`: create a sibling Git worktree from the current repository
- `Add This`: add the current folder or workspace
- `Refresh`: reload the sidebar state

Each listed workspace also has row-level actions:

- `Open Here`
- `Open New Window`
- `Remove`
- `Delete and Remove`

You can also drag entries by the handle on the left to change their order. The order is persisted.

## WSL Support

Workspace Picker tries to support mixed Windows and WSL setups well:

- Windows and WSL entries can live in the same known-workspaces list
- the shared list is stored on the Windows side when possible so both environments can see it
- WSL workspaces can be opened from a non-WSL Windows VS Code session

This is implemented as a best-effort feature because cross-environment path handling depends on the local machine setup, installed VS Code components, and WSL availability.

## Development

Run the extension in an Extension Development Host:

```bash
npm install
npm run build
```

Then press `F5` in VS Code.

To package it:

```bash
npx @vscode/vsce package
```

## Release

For a first Marketplace release:

```bash
npm install
npm run build
npx @vscode/vsce login ArminEberle
npx @vscode/vsce publish
```

This assumes:

- you already created the `ArminEberle` publisher in the Visual Studio Marketplace
- you already created an Azure DevOps Personal Access Token with Marketplace manage permissions

If you want to upload manually instead of publishing directly from the CLI:

```bash
npm install
npm run build
npx @vscode/vsce package
```

Then upload the generated `.vsix` file in the Marketplace publisher portal.

For later releases, bump the version and publish again:

```bash
npx @vscode/vsce publish patch
```

Or choose an explicit version:

```bash
npx @vscode/vsce publish 0.0.2
```

Useful links:

- VS Code extension publishing docs: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Marketplace publisher management: https://marketplace.visualstudio.com/manage/publishers/

## GitHub Actions

This repository includes two GitHub Actions workflows:

- `CI`: runs on pushes and pull requests, installs dependencies, and builds the extension
- `Release`: packages a `.vsix` on demand and on version tags, uploads it as a workflow artifact, and creates a GitHub Release automatically for tags like `v0.0.2`

To cut a GitHub release:

```bash
git tag v0.0.2
git push origin v0.0.2
```

The release workflow will build the extension and attach the generated `.vsix` to the GitHub release.

Marketplace publishing is still manual on purpose. That keeps the first public releases safer while the release process settles down.

## Contributing

Contributions are welcome, but please keep the spirit of the project intact.

Rules for contributing:

- Keep the extension focused on workspace switching, workspace tracking, and lightweight Git/worktree helpers.
- Prefer simple, understandable solutions over clever abstractions.
- Preserve Windows and WSL compatibility when changing path handling or workspace opening behavior.
- Keep the sidebar workflow fast and low-friction.
- Do not add heavy dependencies unless they clearly unlock something important.
- If you change workspace-opening behavior, test both normal local paths and WSL-related paths when possible.
- If you change Git behavior, be conservative and avoid destructive commands.
- Update the README when user-visible behavior changes.
- Keep the vibe-coded energy, but make the result maintainable for the next person.

## License

MIT

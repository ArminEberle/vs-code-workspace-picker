# Workspace Picker

Workspace Picker is a VS Code extension for people who bounce between many folders, repositories, and `.code-workspace` files and want a faster way to reopen them.

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

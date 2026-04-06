# Developing Workspace Picker

This file is intentionally repo-only. It is not linked from `README.md` because the README is used as the Visual Studio Marketplace extension page content.

This document describes the local development flow and the GitHub Actions release flow for this extension.

## Local Development

Install dependencies and build:

```bash
npm install
npm run build
```

Then press `F5` in VS Code to open an Extension Development Host.

Useful commands:

```bash
npm run build
npm run watch
npm run package:vsix
```

## Project Files That Matter For Releases

- `package.json`: extension metadata, version, Marketplace publisher, npm scripts
- `CHANGELOG.md`: release notes for published versions
- `README.md`: Marketplace listing content
- `.vscodeignore`: controls what goes into the packaged extension
- `.github/workflows/ci.yml`: build validation on pushes and pull requests
- `.github/workflows/release.yml`: packaging, GitHub release creation, and Marketplace publishing

## GitHub Actions Overview

There are two workflows in this repository.

### CI

File: `.github/workflows/ci.yml`

Triggered by:

- every push
- every pull request

What it does:

- checks out the repository
- installs dependencies with `npm ci`
- runs `npm run build`

This is the fast feedback workflow that tells you whether the extension still builds.

### Release

File: `.github/workflows/release.yml`

Triggered by:

- pushing a Git tag that matches `v*`
- manual `Run workflow` in GitHub Actions

What it does:

- checks out the repository
- installs dependencies with `npm ci`
- runs `npm run build`
- packages the extension as a `.vsix`
- uploads the `.vsix` as a workflow artifact

On tag pushes, it also:

- verifies the Git tag matches the version in `package.json`
- creates a GitHub Release and attaches the `.vsix`
- publishes the extension to the Visual Studio Marketplace

## Required GitHub Secret

For Marketplace publishing from GitHub Actions, the repository must have this secret configured:

- `VSCE_PAT`: Azure DevOps Personal Access Token with `Marketplace > Manage` scope

GitHub path:

- `Settings`
- `Secrets and variables`
- `Actions`
- `New repository secret`

## Normal Release Flow

The intended release flow is:

1. Make your code changes.
2. Update `README.md` if user-visible behavior changed.
3. Update `CHANGELOG.md`.
4. Bump the extension version:

```bash
npm version patch
```

This updates `package.json`, updates `package-lock.json`, creates a Git commit, and creates a Git tag like `v0.0.2`.

5. Push the branch and tag:

```bash
git push origin main --follow-tags
```

If your default branch is not `main`, replace it with your actual branch name.

6. GitHub Actions will run the `Release` workflow automatically.
7. If the workflow succeeds, the same version will be:

- packaged as a `.vsix`
- attached to a GitHub Release
- published to the VS Code Marketplace

## Manual Release Flow

If you want to test packaging locally without publishing:

```bash
npm install
npm run build
npm run package:vsix
```

If you want to publish manually from your machine:

```bash
npx vsce login ArminEberle
npm run publish:marketplace
```

## Important Guardrails

- The Marketplace publish step in GitHub Actions only runs on tag pushes.
- Manual workflow runs from the GitHub UI package the extension, but do not publish it.
- The release workflow fails if the Git tag version does not match the version in `package.json`.
- `.vscodeignore` decides what ships in the published extension, so update it carefully.

## Troubleshooting

If a GitHub release run fails:

- check whether `VSCE_PAT` is set correctly
- check whether the Git tag matches `package.json`
- check whether the extension still packages locally with `npm run package:vsix`

If Marketplace publishing fails locally:

- verify your publisher is `ArminEberle`
- verify the PAT has `Marketplace > Manage`
- try `npx vsce login ArminEberle` again

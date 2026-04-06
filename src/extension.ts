import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
const STORAGE_FILE_NAME = 'known-workspaces.json';

type EntryKind = 'folder' | 'workspace';
type EntryOrigin = 'windows' | 'wsl' | 'linux' | 'macos' | 'unknown';

interface KnownWorkspaceEntry {
  id: string;
  path: string;
  kind: EntryKind;
  addedAt: string;
  origin: EntryOrigin;
  wslDistro?: string;
}

interface StoredData {
  version: 1;
  entries: KnownWorkspaceEntry[];
}

interface GitInfo {
  repoName: string;
  branch: string;
  stagedCount: number;
  unstagedCount: number;
}

interface EntryPresentation {
  entry: KnownWorkspaceEntry;
  label: string;
  gitInfo?: GitInfo;
  accessible: boolean;
  originLabel: string;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'addNew' }
  | { type: 'addNewWorktree' }
  | { type: 'addCurrent' }
  | { type: 'refresh' }
  | { type: 'openEntry'; id: string; newWindow: boolean }
  | { type: 'reorderEntries'; ids: string[] }
  | { type: 'removeEntry'; id: string }
  | { type: 'deleteAndRemoveEntry'; id: string };

class KnownWorkspacesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workspacePicker.knownWorkspaces';

  private view?: vscode.WebviewView;
  private stateToken = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: KnownWorkspaceStore
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this.handleMessage(message);
    });

    void this.postState();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.workspacePicker');
  }

  async refresh(): Promise<void> {
    await this.postState();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.postState();
          return;
        case 'addNew':
          await addNewEntries(this.store);
          await this.postState();
          return;
        case 'addNewWorktree':
          await addNewWorktree(this.store);
          await this.postState();
          return;
        case 'addCurrent': {
          const added = await addCurrentEntry(this.store);
          if (added) {
            await this.postState();
          }
          return;
        }
        case 'openEntry': {
          const entry = await this.store.findById(message.id);
          if (!entry) {
            return;
          }
          await openKnownEntry(entry, message.newWindow);
          return;
        }
        case 'reorderEntries':
          await this.store.reorder(message.ids);
          await this.postState();
          return;
        case 'removeEntry': {
          const entry = await this.store.findById(message.id);
          if (!entry) {
            return;
          }
          await confirmAndRemoveEntries(this.store, [entry]);
          await this.postState();
          return;
        }
        case 'deleteAndRemoveEntry': {
          const entry = await this.store.findById(message.id);
          if (!entry) {
            return;
          }
          await confirmDeleteAndRemoveEntry(this.store, entry);
          await this.postState();
          return;
        }
      }
    } catch (error) {
      void vscode.window.showErrorMessage(asErrorMessage(error));
    }
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }

    const token = ++this.stateToken;
    const entries = await this.store.list();
    const presentation = await Promise.all(entries.map((entry) => buildBasicEntryPresentation(entry, this.store)));
    await this.view.webview.postMessage({
      type: 'state',
      entries: presentation
    });

    void this.hydrateGitInfo(entries, token);
  }

  private async hydrateGitInfo(entries: KnownWorkspaceEntry[], token: number): Promise<void> {
    const enriched = await Promise.all(entries.map(async (entry) => ({
      id: entry.id,
      gitInfo: await detectGitInfo(entry, this.store)
    })));

    if (!this.view || token !== this.stateToken) {
      return;
    }

    await this.view.webview.postMessage({
      type: 'gitInfo',
      entries: enriched
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Known Workspaces</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }

    .app {
      display: grid;
      gap: 12px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-start;
    }

    .button {
      appearance: none;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 7px;
      padding: 7px 10px;
      cursor: pointer;
      line-height: 1.2;
    }

    .button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .button:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .empty {
      padding: 14px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .list {
      display: grid;
      gap: 8px;
    }

    .entry.dragging {
      opacity: 0.55;
    }

    .entry.drag-over {
      border-color: var(--vscode-focusBorder);
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }

    .entry {
      display: grid;
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background));
    }

    .entry-main {
      min-width: 0;
      display: grid;
      gap: 8px;
    }

    .entry-top {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px;
      align-items: start;
    }

    .drag-handle {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: grab;
      padding: 2px 4px;
      border-radius: 6px;
      font-size: 16px;
      line-height: 1;
      user-select: none;
    }

    .drag-handle:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }

    .entry-header {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 10px;
      align-items: baseline;
    }

    .entry-title {
      font-weight: 600;
      word-break: break-word;
    }

    .entry-meta {
      color: var(--vscode-descriptionForeground);
      word-break: break-word;
    }

    .entry-path {
      color: var(--vscode-descriptionForeground);
      word-break: break-all;
      font-size: 0.95em;
    }

    .entry-path.inaccessible {
      color: var(--vscode-errorForeground);
    }

    .entry-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .mini-button {
      appearance: none;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border-radius: 999px;
      padding: 4px 10px;
      cursor: pointer;
    }

    .mini-button:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .mini-button.remove {
      color: var(--vscode-errorForeground);
    }

  </style>
</head>
<body>
  <div class="app">
    <div class="actions">
      <button class="button primary" data-action="add-new">Add New</button>
      <button class="button" data-action="add-new-worktree">Add New Worktree</button>
      <button class="button" data-action="add-current">Add This</button>
      <button class="button" data-action="refresh">Refresh</button>
    </div>
    <div id="content"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    let entriesState = [];
    let draggingId = null;

    function render(entries) {
      entriesState = entries;

      if (entries.length === 0) {
        content.innerHTML = '<div class="empty">No known workspaces yet. Use Add New or Add This to get started.</div>';
        return;
      }

      const html = entries.map((item) => {
        const id = escapeAttribute(item.entry.id);
        const title = escapeHtml(item.label);
        const meta = escapeHtml(item.gitInfo
          ? item.gitInfo.repoName + ' • ' + item.gitInfo.branch
          : item.originLabel);
        const gitCounts = item.gitInfo
          ? '<div class="entry-meta">Staged: ' + item.gitInfo.stagedCount + ' • Unstaged: ' + item.gitInfo.unstagedCount + '</div>'
          : '';
        const entryPath = escapeHtml(item.entry.path);
        const pathClass = item.accessible ? 'entry-path' : 'entry-path inaccessible';
        const inaccessibleNote = item.accessible ? '' : ' • not accessible from this environment';

        return \`
          <div class="entry" draggable="true" data-entry-id="\${id}">
            <div class="entry-top">
              <button class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</button>
              <div class="entry-main">
                <div class="entry-header">
                  <div class="entry-title">\${title}</div>
                  <div class="entry-meta">\${meta}</div>
                </div>
                \${gitCounts}
                <div class="\${pathClass}">\${entryPath}\${escapeHtml(inaccessibleNote)}</div>
                <div class="entry-actions">
                  <button class="mini-button" data-action="open-current" data-id="\${id}">Open Here</button>
                  <button class="mini-button" data-action="open-new" data-id="\${id}">Open New Window</button>
                  <button class="mini-button remove" data-action="remove-one" data-id="\${id}">Remove</button>
                  <button class="mini-button remove" data-action="delete-remove-one" data-id="\${id}">Delete and Remove</button>
                </div>
              </div>
            </div>
          </div>
        \`;
      }).join('');

      content.innerHTML = '<div class="list">' + html + '</div>';
    }

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const actionHost = target.closest('[data-action]');
      if (!(actionHost instanceof HTMLElement)) {
        return;
      }

      const action = actionHost.dataset.action;
      const id = actionHost.dataset.id;

      if (action === 'add-new') {
        vscode.postMessage({ type: 'addNew' });
        return;
      }

      if (action === 'add-current') {
        vscode.postMessage({ type: 'addCurrent' });
        return;
      }

      if (action === 'add-new-worktree') {
        vscode.postMessage({ type: 'addNewWorktree' });
        return;
      }

      if (action === 'refresh') {
        vscode.postMessage({ type: 'refresh' });
        return;
      }

      if (!id) {
        return;
      }

      if (action === 'open-current') {
        vscode.postMessage({ type: 'openEntry', id, newWindow: false });
        return;
      }

      if (action === 'open-new') {
        vscode.postMessage({ type: 'openEntry', id, newWindow: true });
        return;
      }

      if (action === 'remove-one') {
        vscode.postMessage({ type: 'removeEntry', id });
        return;
      }

      if (action === 'delete-remove-one') {
        vscode.postMessage({ type: 'deleteAndRemoveEntry', id });
      }
    });

    content.addEventListener('dragstart', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const entry = target.closest('[data-entry-id]');
      if (!(entry instanceof HTMLElement)) {
        return;
      }

      draggingId = entry.dataset.entryId || null;
      entry.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggingId || '');
      }
    });

    content.addEventListener('dragend', () => {
      clearDragState();
    });

    content.addEventListener('dragover', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const entry = target.closest('[data-entry-id]');
      if (!(entry instanceof HTMLElement) || !draggingId || entry.dataset.entryId === draggingId) {
        return;
      }

      event.preventDefault();
      clearDropMarkers();
      entry.classList.add('drag-over');
    });

    content.addEventListener('dragleave', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const entry = target.closest('[data-entry-id]');
      if (entry instanceof HTMLElement) {
        entry.classList.remove('drag-over');
      }
    });

    content.addEventListener('drop', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const entry = target.closest('[data-entry-id]');
      if (!(entry instanceof HTMLElement) || !draggingId) {
        return;
      }

      event.preventDefault();
      const targetId = entry.dataset.entryId;
      if (!targetId || targetId === draggingId) {
        clearDragState();
        return;
      }

      const reorderedIds = reorderIds(entriesState.map((item) => item.entry.id), draggingId, targetId);
      clearDragState();
      vscode.postMessage({ type: 'reorderEntries', ids: reorderedIds });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        render(message.entries);
        return;
      }

      if (message.type === 'gitInfo') {
        const byId = new Map(message.entries.map((item) => [item.id, item.gitInfo]));
        entriesState = entriesState.map((entry) => ({
          ...entry,
          gitInfo: byId.has(entry.entry.id) ? byId.get(entry.entry.id) : entry.gitInfo
        }));
        render(entriesState);
      }
    });

    function clearDropMarkers() {
      for (const element of content.querySelectorAll('.drag-over')) {
        element.classList.remove('drag-over');
      }
    }

    function clearDragState() {
      draggingId = null;
      clearDropMarkers();
      for (const element of content.querySelectorAll('.dragging')) {
        element.classList.remove('dragging');
      }
    }

    function reorderIds(ids, draggedId, targetId) {
      const reordered = ids.slice();
      const fromIndex = reordered.indexOf(draggedId);
      const toIndex = reordered.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) {
        return reordered;
      }

      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      return reordered;
    }

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    }

    function escapeAttribute(value) {
      return escapeHtml(value).replaceAll('"', '&quot;');
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new KnownWorkspaceStore(context);
  const provider = new KnownWorkspacesViewProvider(context, store);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KnownWorkspacesViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('workspacePicker.openKnown', async () => {
      await provider.reveal();
    }),
    vscode.commands.registerCommand('workspacePicker.addNew', async () => {
      try {
        await addNewEntries(store);
        await provider.refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(asErrorMessage(error));
      }
    }),
    vscode.commands.registerCommand('workspacePicker.addNewWorktree', async () => {
      try {
        await addNewWorktree(store);
        await provider.refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(asErrorMessage(error));
      }
    }),
    vscode.commands.registerCommand('workspacePicker.addCurrent', async () => {
      try {
        const added = await addCurrentEntry(store);
        if (added) {
          await provider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(asErrorMessage(error));
      }
    }),
    vscode.commands.registerCommand('workspacePicker.refresh', async () => {
      await provider.refresh();
    }),
    vscode.commands.registerCommand('workspacePicker.openEntry', async () => {
      await provider.reveal();
    }),
    vscode.commands.registerCommand('workspacePicker.openEntryInNewWindow', async () => {
      await provider.reveal();
    }),
    vscode.commands.registerCommand('workspacePicker.removeEntry', async () => {
      await provider.reveal();
    })
  );
}

export function deactivate(): void {}

async function buildBasicEntryPresentation(
  entry: KnownWorkspaceEntry,
  store: KnownWorkspaceStore
): Promise<EntryPresentation> {
  const resolvedPath = await store.resolveEntryPath(entry);
  const accessible = resolvedPath ? await pathExists(resolvedPath) : false;

  return {
    entry,
    label: getEntryLabel(entry),
    accessible,
    originLabel: getOriginLabel(entry)
  };
}

async function addNewEntries(store: KnownWorkspaceStore): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Add to known workspaces',
    filters: {
      'VS Code Workspace': ['code-workspace']
    }
  });

  if (!uris || uris.length === 0) {
    return;
  }

  await store.addUris(uris);
}

async function addCurrentEntry(store: KnownWorkspaceStore): Promise<boolean> {
  const uri = getCurrentWorkspaceUri();
  if (!uri) {
    void vscode.window.showInformationMessage('There is no current folder or workspace to add.');
    return false;
  }

  if (uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Only local file-based folders and workspace files can be added.');
    return false;
  }

  await store.addUris([uri]);
  return true;
}

async function addNewWorktree(store: KnownWorkspaceStore): Promise<void> {
  const repoContext = await getCurrentGitRepoContext();
  const branchName = await promptForNewBranchName(repoContext.repoRoot);
  if (!branchName) {
    return;
  }

  const baseBranch = await promptForBaseBranch(repoContext.repoRoot, branchName);
  if (!baseBranch) {
    return;
  }

  const targetPath = getSuggestedWorktreePath(repoContext.workspaceRoot, branchName);
  if (await pathExists(targetPath)) {
    throw new Error(`The target worktree folder already exists: ${targetPath}`);
  }

  await execFileAsync('git', ['-C', repoContext.repoRoot, 'worktree', 'add', '-b', branchName, targetPath, baseBranch]);
  await store.addUris([vscode.Uri.file(targetPath)]);
  void vscode.window.showInformationMessage(`Created worktree "${branchName}" at ${targetPath}`);
}

async function confirmAndRemoveEntries(store: KnownWorkspaceStore, entries: KnownWorkspaceEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    entries.length === 1
      ? `Remove "${getEntryLabel(entries[0])}" from the known workspaces list?`
      : `Remove ${entries.length} selected workspaces from the known workspaces list?`,
    { modal: true },
    'Remove'
  );

  if (confirmed !== 'Remove') {
    return;
  }

  await store.remove(entries.map((entry) => entry.id));
}

async function confirmDeleteAndRemoveEntry(store: KnownWorkspaceStore, entry: KnownWorkspaceEntry): Promise<void> {
  const targetDescription = entry.kind === 'workspace' ? 'workspace file' : 'folder';
  const confirmed = await vscode.window.showWarningMessage(
    `Delete "${getEntryLabel(entry)}" from disk and remove it from the list? This permanently deletes the ${targetDescription}.`,
    { modal: true, detail: entry.path },
    'Delete and Remove'
  );

  if (confirmed !== 'Delete and Remove') {
    return;
  }

  await deleteEntryFromDisk(entry, store);
  await store.remove([entry.id]);
}

function getCurrentWorkspaceUri(): vscode.Uri | undefined {
  if (vscode.workspace.workspaceFile) {
    return vscode.workspace.workspaceFile;
  }

  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0].uri;
  }

  return undefined;
}

async function openKnownEntry(entry: KnownWorkspaceEntry, forceNewWindow: boolean): Promise<void> {
  if (shouldLaunchInWindowsWslSession(entry)) {
    await openEntryInWindowsWslSession(entry);
    return;
  }

  const resolvedPath = await resolveEntryPath(entry);
  if (!resolvedPath) {
    throw new Error(`The workspace path "${entry.path}" is not accessible from this environment.`);
  }

  const uri = vscode.Uri.file(resolvedPath);
  await vscode.commands.executeCommand('vscode.openFolder', uri, forceNewWindow);
}

async function detectGitInfo(
  entry: KnownWorkspaceEntry,
  store: KnownWorkspaceStore
): Promise<GitInfo | undefined> {
  const resolvedPath = await store.resolveEntryPath(entry);
  if (!resolvedPath) {
    return undefined;
  }

  const probePath = entry.kind === 'workspace' ? path.dirname(resolvedPath) : resolvedPath;

  try {
    const { stdout: rootStdout } = await execFileAsync('git', ['-C', probePath, 'rev-parse', '--show-toplevel']);
    const repoRoot = rootStdout.trim();
    if (!repoRoot) {
      return undefined;
    }

    const { stdout: branchStdout } = await execFileAsync('git', ['-C', probePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const { stdout: statusStdout } = await execFileAsync('git', ['-C', probePath, 'status', '--porcelain=v1']);
    const statusCounts = countGitStatusEntries(statusStdout);
    return {
      repoName: path.basename(repoRoot),
      branch: branchStdout.trim() || 'HEAD',
      stagedCount: statusCounts.stagedCount,
      unstagedCount: statusCounts.unstagedCount
    };
  } catch {
    return undefined;
  }
}

async function detectGitWorkspaceInfo(
  entry: KnownWorkspaceEntry,
  store: KnownWorkspaceStore
): Promise<GitWorkspaceInfo | undefined> {
  const resolvedPath = await store.resolveEntryPath(entry);
  if (!resolvedPath) {
    return undefined;
  }

  const probePath = entry.kind === 'workspace' ? path.dirname(resolvedPath) : resolvedPath;

  try {
    const { stdout: repoRootStdout } = await execFileAsync('git', ['-C', probePath, 'rev-parse', '--show-toplevel']);
    const repoRoot = repoRootStdout.trim();
    if (!repoRoot) {
      return undefined;
    }

    const { stdout: commonDirStdout } = await execFileAsync('git', ['-C', probePath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const { stdout: gitDirStdout } = await execFileAsync('git', ['-C', probePath, 'rev-parse', '--path-format=absolute', '--git-dir']);
    const commonDir = path.resolve(commonDirStdout.trim());
    const gitDir = path.resolve(gitDirStdout.trim());

    return {
      repoRoot,
      worktreePath: probePath,
      isMainWorktree: commonDir === gitDir
    };
  } catch {
    return undefined;
  }
}

function countGitStatusEntries(statusOutput: string): { stagedCount: number; unstagedCount: number } {
  let stagedCount = 0;
  let unstagedCount = 0;

  for (const line of statusOutput.split('\n')) {
    if (!line) {
      continue;
    }

    const indexStatus = line[0] ?? ' ';
    const workTreeStatus = line[1] ?? ' ';

    if (indexStatus !== ' ' && indexStatus !== '?') {
      stagedCount += 1;
    }

    if (workTreeStatus !== ' ' || indexStatus === '?') {
      unstagedCount += 1;
    }
  }

  return { stagedCount, unstagedCount };
}

interface GitRepoContext {
  repoRoot: string;
  workspaceRoot: string;
}

interface GitWorkspaceInfo {
  repoRoot: string;
  worktreePath: string;
  isMainWorktree: boolean;
}

interface BranchQuickPickItem extends vscode.QuickPickItem {
  refName: string;
}

function getEntryLabel(entry: KnownWorkspaceEntry): string {
  const basename = getPathBaseName(entry.path);
  return basename || entry.path;
}

function getOriginLabel(entry: KnownWorkspaceEntry): string {
  if (entry.origin === 'wsl' && entry.wslDistro) {
    return `WSL (${entry.wslDistro})`;
  }

  return entry.origin.toUpperCase();
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function getCurrentGitRepoContext(): Promise<GitRepoContext> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
    throw new Error('Open a local folder-based workspace inside a git repository before creating a worktree.');
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  try {
    const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, 'rev-parse', '--show-toplevel']);
    const repoRoot = stdout.trim();
    if (!repoRoot) {
      throw new Error('No git repository was found for the current workspace.');
    }

    return { repoRoot, workspaceRoot };
  } catch {
    throw new Error('The current workspace is not inside a git repository.');
  }
}

async function deleteEntryFromDisk(entry: KnownWorkspaceEntry, store: KnownWorkspaceStore): Promise<void> {
  const resolvedPath = await store.resolveEntryPath(entry);
  if (!resolvedPath) {
    throw new Error(`The workspace path "${entry.path}" is not accessible from this environment.`);
  }

  const gitWorkspaceInfo = await detectGitWorkspaceInfo(entry, store);
  if (gitWorkspaceInfo) {
    if (gitWorkspaceInfo.isMainWorktree) {
      throw new Error('Deleting the primary working tree of a git repository is not allowed. Remove it from the list instead.');
    }

    await execFileAsync('git', [
      '-C',
      gitWorkspaceInfo.repoRoot,
      'worktree',
      'remove',
      '--force',
      gitWorkspaceInfo.worktreePath
    ]);
    return;
  }

  await fs.rm(resolvedPath, {
    recursive: entry.kind === 'folder',
    force: false
  });
}

async function promptForNewBranchName(repoRoot: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Add New Worktree',
    prompt: 'Enter the new branch name',
    ignoreFocusOut: true,
    validateInput: async (value) => {
      const branchName = value.trim();
      if (!branchName) {
        return 'A branch name is required.';
      }

      try {
        await execFileAsync('git', ['-C', repoRoot, 'check-ref-format', '--branch', branchName]);
      } catch {
        return 'This is not a valid git branch name.';
      }

      try {
        await execFileAsync('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
        return 'A local branch with this name already exists.';
      } catch {
        return undefined;
      }
    }
  }).then((value) => value?.trim() || undefined);
}

async function promptForBaseBranch(repoRoot: string, branchName: string): Promise<string | undefined> {
  const branches = await listBaseBranches(repoRoot);
  return vscode.window.showQuickPick(branches, {
    title: 'Add New Worktree',
    placeHolder: `Choose the branch to branch "${branchName}" off from`,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true
  }).then((item) => item?.refName);
}

async function listBaseBranches(repoRoot: string): Promise<BranchQuickPickItem[]> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repoRoot,
    'for-each-ref',
    '--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(subject)',
    'refs/heads',
    'refs/remotes'
  ]);

  const items = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [fullRefName, refName, shortSha, subject] = line.split('\u0000');
      return { fullRefName, refName, shortSha, subject };
    })
    .filter((item) => item.refName && !item.refName.endsWith('/HEAD'))
    .sort((left, right) => compareBranchNames(left.fullRefName, right.fullRefName))
    .map((item) => ({
      label: item.refName,
      description: item.fullRefName.startsWith('refs/remotes/') ? 'remote' : 'local',
      detail: [item.shortSha, item.subject].filter(Boolean).join(' • '),
      refName: item.refName
    }));

  if (items.length === 0) {
    throw new Error('No local or remote branches were found in the current repository.');
  }

  return items;
}

function compareBranchNames(left: string, right: string): number {
  const leftRemote = left.startsWith('refs/remotes/');
  const rightRemote = right.startsWith('refs/remotes/');
  if (leftRemote !== rightRemote) {
    return leftRemote ? 1 : -1;
  }

  return left.localeCompare(right);
}

function getSuggestedWorktreePath(workspaceRoot: string, branchName: string): string {
  const parentPath = path.dirname(workspaceRoot);
  const workspaceName = getPathBaseName(workspaceRoot);
  return path.join(parentPath, `${workspaceName}-${sanitizeForPathSegment(branchName)}`);
}

function sanitizeForPathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'worktree';
}

class KnownWorkspaceStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async list(): Promise<KnownWorkspaceEntry[]> {
    const data = await this.read();
    return data.entries;
  }

  async findById(id: string): Promise<KnownWorkspaceEntry | undefined> {
    const entries = await this.list();
    return entries.find((entry) => entry.id === id);
  }

  async findByIds(ids: string[]): Promise<KnownWorkspaceEntry[]> {
    const idSet = new Set(ids);
    const entries = await this.list();
    return entries.filter((entry) => idSet.has(entry.id));
  }

  async addUris(uris: vscode.Uri[]): Promise<void> {
    const data = await this.read();
    const byKey = new Map(data.entries.map((entry) => [entry.path.toLowerCase(), entry]));
    const orderedEntries = [...data.entries];

    for (const uri of uris) {
      if (uri.scheme !== 'file') {
        continue;
      }

      const fsPath = uri.fsPath;
      const kind: EntryKind = fsPath.endsWith('.code-workspace') ? 'workspace' : 'folder';
      const entry = createEntry(fsPath, kind);
      const key = fsPath.toLowerCase();
      const existing = byKey.get(key);
      byKey.set(key, entry);

      if (existing) {
        const index = orderedEntries.findIndex((candidate) => candidate.id === existing.id);
        if (index >= 0) {
          orderedEntries[index] = entry;
        }
      } else {
        orderedEntries.push(entry);
      }
    }

    data.entries = orderedEntries.filter((entry) => byKey.has(entry.path.toLowerCase()));
    await this.write(data);
  }

  async remove(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    const data = await this.read();
    data.entries = data.entries.filter((entry) => !idSet.has(entry.id));
    await this.write(data);
  }

  async reorder(ids: string[]): Promise<void> {
    const data = await this.read();
    const byId = new Map(data.entries.map((entry) => [entry.id, entry]));
    const reordered = ids
      .map((id) => byId.get(id))
      .filter((entry): entry is KnownWorkspaceEntry => Boolean(entry));
    const remaining = data.entries.filter((entry) => !ids.includes(entry.id));
    data.entries = [...reordered, ...remaining];
    await this.write(data);
  }

  async resolveEntryPath(entry: KnownWorkspaceEntry): Promise<string | undefined> {
    return resolveEntryPath(entry);
  }

  private async read(): Promise<StoredData> {
    const filePath = await getStorageFilePath(this.context);

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredData>;
      return {
        version: 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isKnownWorkspaceEntry) : []
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return {
          version: 1,
          entries: []
        };
      }

      throw error;
    }
  }

  private async write(data: StoredData): Promise<void> {
    const filePath = await getStorageFilePath(this.context);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

function isKnownWorkspaceEntry(value: unknown): value is KnownWorkspaceEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<KnownWorkspaceEntry>;
  return typeof candidate.id === 'string'
    && typeof candidate.path === 'string'
    && (candidate.kind === 'folder' || candidate.kind === 'workspace')
    && typeof candidate.addedAt === 'string'
    && typeof candidate.origin === 'string';
}

function createEntry(entryPath: string, kind: EntryKind): KnownWorkspaceEntry {
  return {
    id: createEntryId(entryPath),
    path: entryPath,
    kind,
    addedAt: new Date().toISOString(),
    origin: detectOrigin(entryPath),
    wslDistro: detectWslDistro(entryPath)
  };
}

function createEntryId(entryPath: string): string {
  const normalized = entryPath.toLowerCase();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
    hash |= 0;
  }
  return `entry-${Math.abs(hash)}`;
}

function detectOrigin(entryPath: string): EntryOrigin {
  if (detectWslDistro(entryPath)) {
    return 'wsl';
  }

  if (isWindowsPath(entryPath)) {
    return 'windows';
  }

  if (entryPath.startsWith('/')) {
    return isWslEnvironment() ? 'wsl' : process.platform === 'darwin' ? 'macos' : 'linux';
  }

  return 'unknown';
}

function detectWslDistro(entryPath: string): string | undefined {
  const uncMatch = /^\\\\wsl(?:\.localhost)?\\([^\\]+)\\/i.exec(entryPath);
  if (uncMatch) {
    return uncMatch[1];
  }

  if (isWslEnvironment()) {
    if (entryPath.startsWith('/')) {
      return process.env.WSL_DISTRO_NAME;
    }
    return undefined;
  }

  return undefined;
}

async function getStorageFilePath(context: vscode.ExtensionContext): Promise<string> {
  const sharedWindowsPath = await getSharedWindowsStoragePath();
  if (sharedWindowsPath) {
    return sharedWindowsPath;
  }

  return path.join(context.globalStorageUri.fsPath, STORAGE_FILE_NAME);
}

async function getSharedWindowsStoragePath(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      return undefined;
    }

    return path.join(appData, 'Code', 'User', 'workspace-picker', STORAGE_FILE_NAME);
  }

  if (!isWslEnvironment()) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync('cmd.exe', ['/c', 'echo', '%APPDATA%']);
    const windowsAppData = stdout.trim();
    if (!windowsAppData || windowsAppData.includes('%APPDATA%')) {
      return undefined;
    }

    return toWslPathFromWindows(path.join(windowsAppData, 'Code', 'User', 'workspace-picker', STORAGE_FILE_NAME));
  } catch {
    return undefined;
  }
}

async function resolveEntryPath(entry: KnownWorkspaceEntry): Promise<string | undefined> {
  const candidates = [entry.path];

  if (isWslEnvironment() && isWindowsPath(entry.path)) {
    candidates.unshift(toWslPathFromWindows(entry.path));
  } else if (process.platform === 'win32' && entry.origin === 'wsl' && entry.wslDistro && entry.path.startsWith('/')) {
    candidates.unshift(toWindowsPathFromWsl(entry.path, entry.wslDistro));
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:\\/.test(value) || /^\\\\/.test(value);
}

function isWslEnvironment(): boolean {
  return process.platform === 'linux'
    && (Boolean(process.env.WSL_DISTRO_NAME) || os.release().toLowerCase().includes('microsoft'));
}

function toWslPathFromWindows(windowsPath: string): string {
  if (windowsPath.startsWith('\\\\')) {
    return windowsPath;
  }

  const driveLetter = windowsPath[0]?.toLowerCase();
  const remainder = windowsPath.slice(2).replaceAll('\\', '/');
  return `/mnt/${driveLetter}${remainder}`;
}

function toWindowsPathFromWsl(wslPath: string, distro: string): string {
  return `\\\\wsl.localhost\\${distro}${wslPath.replaceAll('/', '\\')}`;
}

function shouldLaunchInWindowsWslSession(entry: KnownWorkspaceEntry): boolean {
  return process.platform === 'win32'
    && entry.origin === 'wsl'
    && Boolean(entry.wslDistro)
    && (entry.path.startsWith('/') || isUncWslPath(entry.path));
}

async function openEntryInWindowsWslSession(entry: KnownWorkspaceEntry): Promise<void> {
  const distro = entry.wslDistro;
  if (!distro) {
    throw new Error('This WSL workspace does not have a recorded distro name, so it cannot be opened automatically.');
  }

  const targetPath = getWslRemotePath(entry);
  const remoteAuthority = `wsl+${distro}`;
  const remoteUri = vscode.Uri.from({
    scheme: 'vscode-remote',
    authority: remoteAuthority,
    path: targetPath
  });

  try {
    await vscode.commands.executeCommand('vscode.openFolder', remoteUri, true);
    return;
  } catch (error) {
    try {
      await runWindowsCodeCommand([
        '--folder-uri',
        remoteUri.toString()
      ]);
      return;
    } catch (fallbackError) {
      throw new Error(
        `Failed to open the workspace in WSL. Make sure Windows VS Code and the Remote - WSL extension are installed. ${asErrorMessage(fallbackError)}`
      );
    }
  }
}

async function runWindowsCodeCommand(args: string[]): Promise<void> {
  await execFileAsync('cmd.exe', ['/d', '/c', 'code', ...args], { windowsHide: true });
}

function getProcessErrorOutput(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const processError = error as { message?: string; stdout?: string; stderr?: string };
  return [processError.message, processError.stdout, processError.stderr].filter(Boolean).join(' ');
}

function getWslRemotePath(entry: KnownWorkspaceEntry): string {
  if (entry.path.startsWith('/')) {
    return entry.path;
  }

  return uncWslPathToLinuxPath(entry.path);
}

function uncWslPathToLinuxPath(targetPath: string): string {
  const match = /^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.*)$/i.exec(targetPath);
  if (!match) {
    throw new Error(`The path "${targetPath}" is not a valid WSL UNC path.`);
  }

  return `/${match[1].replaceAll('\\', '/')}`;
}

function isUncWslPath(value: string): boolean {
  return /^\\\\wsl(?:\.localhost)?\\[^\\]+\\/i.test(value);
}

function getPathBaseName(targetPath: string): string {
  if (isWindowsPath(targetPath)) {
    return path.win32.basename(targetPath);
  }

  return path.posix.basename(targetPath);
}

function createNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 32; index += 1) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

import * as fs from 'fs/promises';
import { watch as fsWatch, type FSWatcher } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { GitInfo, KnownWorkspaceEntry, KnownWorkspaceStore, OpenWorkspaceSession } from './store';
import { getPreferredNewWorktreeWorkspacePath } from './worktreeWorkspace';

const execFileAsync = promisify(execFile);
const EXTENSION_STORAGE_DIR = 'vs-code-workspace-picker';
const OPEN_WORKSPACE_HEARTBEAT_MS = 30_000;
const OPEN_WORKSPACE_STALE_MS = 90_000;

type EntryOrigin = 'windows' | 'wsl' | 'linux' | 'macos' | 'unknown';

interface EntryOpenState {
  label: string;
  lastSeenLabel: string;
  canFocus: boolean;
}

interface EntryPresentation {
  entry: KnownWorkspaceEntry;
  label: string;
  gitInfo?: GitInfo;
  accessible: boolean;
  originLabel: string;
  isCurrentWorkspace: boolean;
  openState?: EntryOpenState;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'addNewWorktree' }
  | { type: 'addCurrent' }
  | { type: 'gitFetch' }
  | { type: 'refresh' }
  | { type: 'openEntry'; id: string; newWindow: boolean }
  | { type: 'focusOpenEntry'; id: string }
  | { type: 'reorderEntries'; ids: string[] }
  | { type: 'reorderGroups'; groupIds: string[] }
  | { type: 'removeEntry'; id: string }
  | { type: 'deleteAndRemoveEntry'; id: string };

interface GitExtensionApi {
  repositories: GitRepository[];
  onDidOpenRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
}

interface GitRepository {
  state: GitRepositoryState;
}

interface GitRepositoryState {
  onDidChange(listener: () => void): vscode.Disposable;
}

interface WorkspacePickerExtensionApi {
  listEntries(): Promise<KnownWorkspaceEntry[]>;
  getGroupOrder(): Promise<string[]>;
  getStorageRootDir(): Promise<string>;
  addEntriesForTests(paths: string[]): Promise<void>;
}

let activatedApi: WorkspacePickerExtensionApi | undefined;

class KnownWorkspacesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workspacePicker.knownWorkspaces';

  private view?: vscode.WebviewView;
  private lastPostedStateJson?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: KnownWorkspaceStore,
    private readonly sessionId: string
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
        case 'gitFetch':
          await fetchCurrentGitRepository();
          await this.postState();
          return;
        case 'openEntry': {
          const entry = await this.store.findById(message.id);
          if (!entry) {
            return;
          }
          await openKnownEntry(entry, message.newWindow);
          return;
        }
        case 'focusOpenEntry': {
          const entry = await this.store.findById(message.id);
          if (!entry) {
            return;
          }
          await focusOpenEntry(entry);
          return;
        }
        case 'reorderEntries':
          await this.store.reorder(message.ids);
          await this.postState();
          return;
        case 'reorderGroups':
          await this.store.reorderGroups(message.groupIds);
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

    const entries = await this.store.list();
    const groupOrder = await this.store.getGroupOrder();
    const canAddCurrent = !await hasCurrentWorkspaceEntry(entries, this.store);
    const sessionsByEntryId = await this.store.listOpenSessionsByEntryIds(entries.map((entry) => entry.id));
    const presentation = await Promise.all(entries.map((entry) => buildBasicEntryPresentation(
      entry,
      this.store,
      this.sessionId,
      sessionsByEntryId.get(entry.id) ?? []
    )));
    const message = {
      type: 'state',
      entries: presentation,
      groupOrder,
      canAddCurrent
    };
    const messageJson = JSON.stringify(message);
    if (messageJson === this.lastPostedStateJson) {
      return;
    }
    this.lastPostedStateJson = messageJson;
    await this.view.webview.postMessage(message);
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

    .group {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      overflow: hidden;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-editor-background));
    }

    .group.dragging {
      opacity: 0.55;
    }

    .group.drag-over {
      border-color: var(--vscode-focusBorder);
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }

    .group summary {
      list-style: none;
      cursor: pointer;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      user-select: none;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-editor-background));
    }

    .group summary::-webkit-details-marker {
      display: none;
    }

    .group-title {
      font-weight: 600;
      min-width: 0;
      word-break: break-word;
    }

    .group-head {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px;
      align-items: center;
      min-width: 0;
      flex: 1;
    }

    .group-meta {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      font-size: 0.95em;
    }

    .group-list {
      display: grid;
      gap: 8px;
      padding: 8px;
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

    .entry-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 70%, transparent);
      background: color-mix(in srgb, var(--vscode-focusBorder) 14%, transparent);
      color: var(--vscode-foreground);
      font-size: 0.9em;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      white-space: nowrap;
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
      <button class="button primary" data-action="add-current">Add This</button>
      <button class="button" data-action="add-new-worktree">Add New Worktree</button>
      <button class="button" data-action="git-fetch">Git Fetch</button>
      <button class="button" data-action="refresh">Refresh</button>
    </div>
    <div id="content"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    const addCurrentButton = document.querySelector('[data-action="add-current"]');
    let entriesState = [];
    let groupOrderState = [];
    let canAddCurrentState = true;
    let draggingId = null;
    let draggingType = null;
    const openGroups = new Map();

    function render(entries, groupOrder, canAddCurrent) {
      entriesState = entries;
      groupOrderState = groupOrder;
      canAddCurrentState = canAddCurrent;

      if (addCurrentButton instanceof HTMLButtonElement) {
        addCurrentButton.disabled = !canAddCurrentState;
        addCurrentButton.title = canAddCurrentState ? '' : 'The current workspace is already in the list';
      }

      if (entries.length === 0) {
        content.innerHTML = '<div class="empty">No known workspaces yet. Use Add This to get started.</div>';
        return;
      }

      const groups = groupEntries(entries, groupOrder);
      const html = groups.map((group) => {
        const groupId = escapeAttribute(group.id);
        const isOpen = openGroups.has(group.id) ? openGroups.get(group.id) : false;
        const groupEntriesHtml = group.entries.map((item) => {
        const id = escapeAttribute(item.entry.id);
        const title = escapeHtml(item.label);
        const meta = escapeHtml(item.gitInfo
          ? [item.gitInfo.repoName, item.gitInfo.branch].filter(Boolean).join(' • ')
          : item.originLabel);
        const gitCounts = item.gitInfo && typeof item.gitInfo.stagedCount === 'number' && typeof item.gitInfo.unstagedCount === 'number'
          ? '<div class="entry-meta">Staged: ' + item.gitInfo.stagedCount + ' • Unstaged: ' + item.gitInfo.unstagedCount + '</div>'
          : '';
        const currentBadge = item.isCurrentWorkspace
          ? '<div class="entry-badge">YOU ARE HERE</div>'
          : '';
        const openStateMeta = item.openState
          ? '<div class="entry-meta">' + escapeHtml(item.openState.label + ' • ' + item.openState.lastSeenLabel) + '</div>'
          : '';
        const focusButton = item.openState && item.openState.canFocus
          ? '<button class="mini-button" data-action="focus-open" data-id="' + id + '">Focus Other Window</button>'
          : '';
        const actionButtons = item.isCurrentWorkspace
          ? focusButton
            + '<button class="mini-button remove" data-action="remove-one" data-id="' + id + '">Remove</button>'
          : '<button class="mini-button" data-action="open-current" data-id="' + id + '">Open Here</button>'
            + '<button class="mini-button" data-action="open-new" data-id="' + id + '">Open New Window</button>'
            + focusButton
            + '<button class="mini-button remove" data-action="remove-one" data-id="' + id + '">Remove</button>'
            + '<button class="mini-button remove" data-action="delete-remove-one" data-id="' + id + '">Delete and Remove</button>';
        const entryPath = escapeHtml(item.entry.path);
        const pathClass = item.accessible ? 'entry-path' : 'entry-path inaccessible';
        const inaccessibleNote = item.accessible ? '' : ' • not accessible from this environment';

        return \`
          <div class="entry" data-entry-id="\${id}">
            <div class="entry-top">
              <button class="drag-handle" draggable="true" data-drag-kind="entry" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</button>
              <div class="entry-main">
                <div class="entry-header">
                  <div class="entry-title">\${title}</div>
                  \${currentBadge}
                  <div class="entry-meta">\${meta}</div>
                </div>
                \${gitCounts}
                \${openStateMeta}
                <div class="\${pathClass}">\${entryPath}\${escapeHtml(inaccessibleNote)}</div>
                <div class="entry-actions">
                  \${actionButtons}
                </div>
              </div>
            </div>
          </div>
        \`;
      }).join('');

        return \`
          <details class="group" data-group-id="\${groupId}" \${isOpen ? 'open' : ''}>
            <summary>
              <span class="group-head">
                <button class="drag-handle" draggable="true" data-drag-kind="group" title="Drag group to reorder" aria-label="Drag group to reorder">⋮⋮</button>
                <span class="group-title">\${escapeHtml(group.label)}</span>
              </span>
              <span class="group-meta">\${group.entries.length} workspace\${group.entries.length === 1 ? '' : 's'}</span>
            </summary>
            <div class="group-list">
              \${groupEntriesHtml}
            </div>
          </details>
        \`;
      }).join('');

      content.innerHTML = '<div class="list">' + html + '</div>';
    }

    function groupEntries(entries, groupOrder) {
      const groups = [];
      const byId = new Map();

      for (const entry of entries) {
        const remoteKey = entry.gitInfo && entry.gitInfo.remoteGroupKey ? entry.gitInfo.remoteGroupKey : '__no_remote__';
        const groupId = remoteKey;
        if (!byId.has(groupId)) {
          const label = entry.gitInfo && entry.gitInfo.remoteLabel
            ? entry.gitInfo.remoteLabel
            : 'Other Workspaces';
          const group = { id: groupId, label, entries: [] };
          byId.set(groupId, group);
          groups.push(group);
        }

        byId.get(groupId).entries.push(entry);
      }

      const orderMap = new Map(groupOrder.map((groupId, index) => [groupId, index]));
      return groups.sort((left, right) => {
        const leftIndex = orderMap.has(left.id) ? orderMap.get(left.id) : Number.MAX_SAFE_INTEGER;
        const rightIndex = orderMap.has(right.id) ? orderMap.get(right.id) : Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) {
          return leftIndex - rightIndex;
        }
        return 0;
      });
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

      if (action === 'add-current') {
        vscode.postMessage({ type: 'addCurrent' });
        return;
      }

      if (action === 'add-new-worktree') {
        vscode.postMessage({ type: 'addNewWorktree' });
        return;
      }

      if (action === 'git-fetch') {
        vscode.postMessage({ type: 'gitFetch' });
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

      if (action === 'focus-open') {
        vscode.postMessage({ type: 'focusOpenEntry', id });
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

      const dragHandle = target.closest('[data-drag-kind]');
      if (!(dragHandle instanceof HTMLElement)) {
        return;
      }

      const dragKind = dragHandle.dataset.dragKind;

      if (dragKind === 'entry') {
        const entry = dragHandle.closest('[data-entry-id]');
        if (!(entry instanceof HTMLElement)) {
          return;
        }

        draggingType = 'entry';
        draggingId = entry.dataset.entryId || null;
        entry.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', draggingId || '');
        }
        return;
      }

      if (dragKind === 'group') {
        const group = dragHandle.closest('[data-group-id]');
        if (!(group instanceof HTMLElement)) {
          return;
        }

        draggingType = 'group';
        draggingId = group.dataset.groupId || null;
        group.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', draggingId || '');
        }
        return;
      }
    });

    content.addEventListener('dragend', () => {
      clearDragState();
    });

    content.addEventListener('toggle', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement) || !target.matches('.group')) {
        return;
      }

      const groupId = target.dataset.groupId;
      if (groupId) {
        openGroups.set(groupId, target.open);
      }
    }, true);

    content.addEventListener('dragover', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (draggingType === 'group') {
        const group = target.closest('[data-group-id]');
        if (!(group instanceof HTMLElement) || !draggingId || group.dataset.groupId === draggingId) {
          return;
        }

        event.preventDefault();
        clearDropMarkers();
        group.classList.add('drag-over');
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

      const group = target.closest('[data-group-id]');
      if (group instanceof HTMLElement) {
        group.classList.remove('drag-over');
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

      if (draggingType === 'group') {
        const group = target.closest('[data-group-id]');
        if (!(group instanceof HTMLElement) || !draggingId) {
          return;
        }

        event.preventDefault();
        const targetGroupId = group.dataset.groupId;
        if (!targetGroupId || targetGroupId === draggingId) {
          clearDragState();
          return;
        }

        const reorderedGroupIds = reorderGroupList(groupEntries(entriesState, groupOrderState).map((group) => group.id), draggingId, targetGroupId);
        clearDragState();
        vscode.postMessage({ type: 'reorderGroups', groupIds: reorderedGroupIds });
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
        render(message.entries, message.groupOrder || [], message.canAddCurrent !== false);
        return;
      }

      if (message.type === 'gitInfo') {
        const byId = new Map(message.entries.map((item) => [item.id, item.gitInfo]));
        entriesState = entriesState.map((entry) => ({
          ...entry,
          gitInfo: byId.has(entry.entry.id) ? byId.get(entry.entry.id) : entry.gitInfo
        }));
        render(entriesState, groupOrderState, canAddCurrentState);
      }
    });

    function clearDropMarkers() {
      for (const element of content.querySelectorAll('.drag-over')) {
        element.classList.remove('drag-over');
      }
    }

    function clearDragState() {
      draggingId = null;
      draggingType = null;
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

    function reorderGroupList(groupIds, draggedGroupId, targetGroupId) {
      const reorderedGroups = groupIds.slice();
      const fromIndex = reorderedGroups.indexOf(draggedGroupId);
      const toIndex = reorderedGroups.indexOf(targetGroupId);
      if (fromIndex < 0 || toIndex < 0) {
        return reorderedGroups;
      }

      const [moved] = reorderedGroups.splice(fromIndex, 1);
      reorderedGroups.splice(toIndex, 0, moved);
      return reorderedGroups;
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

export function activate(context: vscode.ExtensionContext): WorkspacePickerExtensionApi {
  if (activatedApi) {
    return activatedApi;
  }

  const sessionId = createRuntimeSessionId();
  const store = new KnownWorkspaceStore({
    getStorageRootDir: async () => getStorageRootDir(context),
    detectOrigin,
    detectWslDistro,
    resolveEntryPath
  });
  const provider = new KnownWorkspacesViewProvider(context, store, sessionId);
  const currentWorkspaceSync = new CurrentWorkspaceGitSync(store, provider);
  const currentWorkspacePresenceSync = new CurrentWorkspacePresenceSync(store, provider, sessionId);
  const storageWatcher = new StorageWatcher(store, () => {
    void provider.refresh();
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KnownWorkspacesViewProvider.viewType, provider)
  );

  context.subscriptions.push(currentWorkspaceSync);
  context.subscriptions.push(currentWorkspacePresenceSync);
  context.subscriptions.push(storageWatcher);
  void currentWorkspaceSync.initialize().then(() => currentWorkspaceSync.sync());
  void currentWorkspacePresenceSync.initialize().then(() => currentWorkspacePresenceSync.sync());
  void storageWatcher.start();

  context.subscriptions.push(
    vscode.commands.registerCommand('workspacePicker.openKnown', async () => {
      await provider.reveal();
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
          await currentWorkspaceSync.sync();
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

  activatedApi = {
    listEntries: () => store.list(),
    getGroupOrder: () => store.getGroupOrder(),
    getStorageRootDir: () => getStorageRootDir(context),
    addEntriesForTests: async (paths) => {
      await store.addUris(paths.map((entryPath) => vscode.Uri.file(entryPath)));
      await provider.refresh();
    }
  };

  return activatedApi;
}

export function deactivate(): void {
  activatedApi = undefined;
}

class StorageWatcher implements vscode.Disposable {
  private readonly watchers: FSWatcher[] = [];
  private debounceTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly store: KnownWorkspaceStore,
    private readonly onChanged: () => void,
    private readonly debounceMs: number = 250
  ) {}

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      await this.store.ensureStorageDirectories();
    } catch {
      return;
    }

    if (this.disposed) {
      return;
    }

    const dirs = await this.store.getStorageDirectories();
    this.attach(dirs.rootDir);
    this.attach(dirs.entriesDir);
    this.attach(dirs.openSessionsDir);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers.length = 0;
  }

  private attach(dir: string): void {
    try {
      const watcher = fsWatch(dir, { persistent: false }, () => this.scheduleRefresh());
      watcher.on('error', () => {
        // best-effort; the next refresh from a heartbeat or user action will recover
      });
      this.watchers.push(watcher);
    } catch {
      // ignore; some platforms may not support watching every directory
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.disposed) {
        return;
      }
      this.onChanged();
    }, this.debounceMs);
  }
}

class CurrentWorkspaceGitSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private syncInFlight?: Promise<void>;
  private initialized = false;

  constructor(
    private readonly store: KnownWorkspaceStore,
    private readonly provider: KnownWorkspacesViewProvider
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    const gitApi = await getGitExtensionApi();
    if (!gitApi) {
      return;
    }

    this.disposables.push(gitApi.onDidOpenRepository((repository) => {
      this.registerRepository(repository);
      void this.sync();
    }));

    for (const repository of gitApi.repositories) {
      this.registerRepository(repository);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async sync(): Promise<void> {
    await this.initialize();

    if (this.syncInFlight) {
      await this.syncInFlight;
      return;
    }

    this.syncInFlight = this.syncCurrentWorkspaceGitInfo();
    try {
      await this.syncInFlight;
    } finally {
      this.syncInFlight = undefined;
    }
  }

  private registerRepository(repository: GitRepository): void {
    this.disposables.push(repository.state.onDidChange(() => {
      void this.sync();
    }));
  }

  private async syncCurrentWorkspaceGitInfo(): Promise<void> {
    const entries = await this.store.list();
    if (entries.length === 0) {
      return;
    }

    const updates = await Promise.all(entries.map(async (entry) => ({
      id: entry.id,
      gitInfo: await detectGitInfo(entry, this.store)
    })));
    const changed = await this.store.updateGitInfoCache(updates);
    if (changed) {
      await this.provider.refresh();
    }
  }
}

class CurrentWorkspacePresenceSync implements vscode.Disposable {
  private interval?: NodeJS.Timeout;
  private currentEntryId?: string;
  private syncInFlight?: Promise<void>;

  constructor(
    private readonly store: KnownWorkspaceStore,
    private readonly provider: KnownWorkspacesViewProvider,
    private readonly sessionId: string
  ) {}

  async initialize(): Promise<void> {
    if (this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      void this.sync();
    }, OPEN_WORKSPACE_HEARTBEAT_MS);
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    if (this.currentEntryId) {
      void this.store.removeOpenSession(this.currentEntryId, this.sessionId);
    }
  }

  async sync(): Promise<void> {
    if (this.syncInFlight) {
      await this.syncInFlight;
      return;
    }

    this.syncInFlight = this.syncPresence();
    try {
      await this.syncInFlight;
    } finally {
      this.syncInFlight = undefined;
    }
  }

  private async syncPresence(): Promise<void> {
    const entries = await this.store.list();
    const currentEntry = await findCurrentWorkspaceEntry(entries, this.store);

    if (this.currentEntryId && (!currentEntry || currentEntry.id !== this.currentEntryId)) {
      await this.store.removeOpenSession(this.currentEntryId, this.sessionId);
      this.currentEntryId = undefined;
    }

    if (currentEntry) {
      if (this.currentEntryId === currentEntry.id) {
        try {
          await this.store.touchOpenSession(currentEntry.id, this.sessionId);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await this.store.upsertOpenSession(currentEntry.id, this.buildSessionBody());
          } else {
            throw error;
          }
        }
      } else {
        await this.store.upsertOpenSession(currentEntry.id, this.buildSessionBody());
        this.currentEntryId = currentEntry.id;
      }
    }

    await this.store.pruneOpenSessions(OPEN_WORKSPACE_STALE_MS * 4);
    await this.provider.refresh();
  }

  private buildSessionBody(): OpenWorkspaceSession {
    return {
      sessionId: this.sessionId,
      processId: process.pid,
      lastSeenAt: new Date().toISOString(),
      environment: getRuntimeEnvironmentOrigin(),
      hostName: os.hostname(),
      appName: vscode.env.appName
    };
  }
}

async function buildBasicEntryPresentation(
  entry: KnownWorkspaceEntry,
  store: KnownWorkspaceStore,
  currentSessionId: string,
  openSessions: OpenWorkspaceSession[]
): Promise<EntryPresentation> {
  const resolvedPath = await store.resolveEntryPath(entry);
  const accessible = resolvedPath ? await pathExists(resolvedPath) : false;
  const cachedGitInfo = entry.cachedGitInfo
    ? {
        repoName: entry.cachedGitInfo.repoName ?? getEntryLabel(entry),
        branch: entry.cachedGitInfo.branch ?? '',
        remoteGroupKey: entry.cachedGitInfo.remoteGroupKey,
        remoteLabel: entry.cachedGitInfo.remoteLabel
      }
    : undefined;

  const freshestOtherSession = getFreshestOtherOpenSession(openSessions, currentSessionId);

  return {
    entry,
    label: getEntryLabel(entry),
    gitInfo: cachedGitInfo,
    accessible,
    originLabel: getOriginLabel(entry),
    isCurrentWorkspace: await isCurrentWorkspaceEntry(entry, store),
    openState: freshestOtherSession
      ? {
          label: formatOpenSessionLabel(freshestOtherSession, openSessions.length - 1),
          lastSeenLabel: formatRelativeTime(freshestOtherSession.lastSeenAt),
          canFocus: true
        }
      : undefined
  };
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

async function fetchCurrentGitRepository(): Promise<void> {
  const repoContext = await getCurrentGitRepoContext();
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Workspace Picker: Fetching Git branches'
  }, async () => {
    await execFileAsync('git', ['-C', repoContext.repoRoot, 'fetch', '--all', '--prune']);
  });
  void vscode.window.showInformationMessage('Fetched Git branches for the current repository.');
}

async function isCurrentWorkspaceEntry(
  entry: KnownWorkspaceEntry,
  store: KnownWorkspaceStore
): Promise<boolean> {
  const currentWorkspaceUri = getCurrentWorkspaceUri();
  if (!currentWorkspaceUri || currentWorkspaceUri.scheme !== 'file') {
    return false;
  }

  const currentWorkspacePath = currentWorkspaceUri.fsPath;
  if (pathsMatch(entry.path, currentWorkspacePath)) {
    return true;
  }

  const resolvedPath = await store.resolveEntryPath(entry);
  return Boolean(resolvedPath && pathsMatch(resolvedPath, currentWorkspacePath));
}

async function findCurrentWorkspaceEntry(
  entries: KnownWorkspaceEntry[],
  store: KnownWorkspaceStore
): Promise<KnownWorkspaceEntry | undefined> {
  const currentWorkspaceUri = getCurrentWorkspaceUri();
  if (!currentWorkspaceUri || currentWorkspaceUri.scheme !== 'file') {
    return undefined;
  }

  for (const entry of entries) {
    if (await isCurrentWorkspaceEntry(entry, store)) {
      return entry;
    }
  }

  return undefined;
}

async function hasCurrentWorkspaceEntry(
  entries: KnownWorkspaceEntry[],
  store: KnownWorkspaceStore
): Promise<boolean> {
  return Boolean(await findCurrentWorkspaceEntry(entries, store));
}

async function addNewWorktree(store: KnownWorkspaceStore): Promise<void> {
  const repoContext = await getCurrentGitRepoContext();
  const mode = await promptForWorktreeMode();
  if (!mode) {
    return;
  }

  if (mode === 'newBranch') {
    await addNewBranchWorktree(store, repoContext);
    return;
  }

  await addExistingBranchWorktree(store, repoContext);
}

async function addNewBranchWorktree(
  store: KnownWorkspaceStore,
  repoContext: GitRepoContext
): Promise<void> {
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
  const workspacePath = await getNewWorktreeWorkspacePath(repoContext, targetPath);
  await addWorkspacePathWithGitInfo(store, workspacePath);
  void vscode.window.showInformationMessage(`Created worktree "${branchName}" at ${targetPath}`);
}

async function addExistingBranchWorktree(
  store: KnownWorkspaceStore,
  repoContext: GitRepoContext
): Promise<void> {
  const branchName = await promptForExistingBranch(repoContext.repoRoot);
  if (!branchName) {
    return;
  }

  const targetPath = getSuggestedExistingBranchWorktreePath(repoContext.workspaceRoot, branchName);
  if (await pathExists(targetPath)) {
    throw new Error(`The target worktree folder already exists: ${targetPath}`);
  }

  await execFileAsync('git', ['-C', repoContext.repoRoot, 'worktree', 'add', targetPath, branchName]);
  const workspacePath = await getNewWorktreeWorkspacePath(repoContext, targetPath);
  await addWorkspacePathWithGitInfo(store, workspacePath);
  void vscode.window.showInformationMessage(`Created worktree for "${branchName}" at ${targetPath}`);
}

async function getNewWorktreeWorkspacePath(repoContext: GitRepoContext, worktreeRoot: string): Promise<string> {
  const preferredPath = getPreferredNewWorktreeWorkspacePath({
    repoRoot: repoContext.repoRoot,
    currentWorkspaceRoot: repoContext.workspaceRoot,
    currentWorkspaceFile: repoContext.workspaceFile,
    worktreeRoot
  });
  if (await pathExists(preferredPath)) {
    return preferredPath;
  }

  const folderFallbackPath = getPreferredNewWorktreeWorkspacePath({
    repoRoot: repoContext.repoRoot,
    currentWorkspaceRoot: repoContext.workspaceRoot,
    worktreeRoot
  });
  if (await pathExists(folderFallbackPath)) {
    return folderFallbackPath;
  }

  return worktreeRoot;
}

async function addWorkspacePathWithGitInfo(store: KnownWorkspaceStore, workspacePath: string): Promise<void> {
  await store.addUris([vscode.Uri.file(workspacePath)]);

  const entries = await store.list();
  const entry = entries.find((candidate) => pathsMatch(candidate.path, workspacePath));
  if (!entry) {
    return;
  }

  await store.updateGitInfoCacheIfChanged(entry.id, await detectGitInfo(entry, store));
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

  if (shouldLaunchInWindowsLocalSession(entry)) {
    await openEntryInWindowsLocalSession(entry, forceNewWindow);
    return;
  }

  const resolvedPath = await resolveEntryPath(entry);
  if (!resolvedPath) {
    throw new Error(`The workspace path "${entry.path}" is not accessible from this environment.`);
  }

  const uri = vscode.Uri.file(resolvedPath);
  await vscode.commands.executeCommand('vscode.openFolder', uri, forceNewWindow);
}

async function focusOpenEntry(entry: KnownWorkspaceEntry): Promise<void> {
  if (shouldLaunchInWindowsWslSession(entry)) {
    const distro = entry.wslDistro;
    if (!distro) {
      throw new Error('This WSL workspace does not have a recorded distro name, so it cannot be focused automatically.');
    }

    const remoteUri = vscode.Uri.from({
      scheme: 'vscode-remote',
      authority: `wsl+${distro}`,
      path: getWslRemotePath(entry)
    });
    await runWindowsCodeCommand(['--folder-uri', remoteUri.toString()]);
    return;
  }

  if (shouldLaunchInWindowsLocalSession(entry)) {
    await runWindowsCodeCommand([entry.path]);
    return;
  }

  const resolvedPath = await resolveEntryPath(entry);
  if (!resolvedPath) {
    throw new Error(`The workspace path "${entry.path}" is not accessible from this environment.`);
  }

  if (process.platform === 'win32') {
    await runWindowsCodeCommand([resolvedPath]);
    return;
  }

  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-a', 'Visual Studio Code', resolvedPath]);
    return;
  }

  await execFileAsync('code', [resolvedPath]);
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
    const remoteInfo = await detectRemoteInfo(probePath);
    const statusCounts = countGitStatusEntries(statusStdout);
    return {
      repoName: path.basename(repoRoot),
      branch: branchStdout.trim() || 'HEAD',
      stagedCount: statusCounts.stagedCount,
      unstagedCount: statusCounts.unstagedCount,
      remoteGroupKey: remoteInfo?.key,
      remoteLabel: remoteInfo?.label
    };
  } catch {
    return undefined;
  }
}

async function detectRemoteInfo(probePath: string): Promise<{ key: string; label: string } | undefined> {
  try {
    const { stdout: remotesStdout } = await execFileAsync('git', ['-C', probePath, 'remote']);
    const remotes = remotesStdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (remotes.length === 0) {
      return undefined;
    }

    const preferredRemote = remotes.includes('origin') ? 'origin' : remotes[0];
    const { stdout: urlStdout } = await execFileAsync('git', ['-C', probePath, 'remote', 'get-url', preferredRemote]);
    const remoteUrl = urlStdout.trim();
    if (!remoteUrl) {
      return undefined;
    }

    return {
      key: normalizeRemoteUrl(remoteUrl),
      label: formatRemoteLabel(remoteUrl)
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
  workspaceFile?: string;
}

interface GitWorkspaceInfo {
  repoRoot: string;
  worktreePath: string;
  isMainWorktree: boolean;
}

interface BranchQuickPickItem extends vscode.QuickPickItem {
  refName: string;
}

interface WorktreeModeQuickPickItem extends vscode.QuickPickItem {
  mode: 'newBranch' | 'existingBranch';
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

function getRuntimeEnvironmentOrigin(): EntryOrigin {
  if (isWslEnvironment()) {
    return 'wsl';
  }

  if (process.platform === 'win32') {
    return 'windows';
  }

  if (process.platform === 'darwin') {
    return 'macos';
  }

  if (process.platform === 'linux') {
    return 'linux';
  }

  return 'unknown';
}

function createRuntimeSessionId(): string {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getFreshestOtherOpenSession(
  sessions: OpenWorkspaceSession[],
  currentSessionId: string
): OpenWorkspaceSession | undefined {
  const cutoff = Date.now() - OPEN_WORKSPACE_STALE_MS;
  const localHostName = os.hostname();
  const otherSessions = sessions
    .filter((session) => session.sessionId !== currentSessionId)
    .filter((session) => {
      if (session.hostName === localHostName) {
        return isProcessAlive(session.processId);
      }
      const lastSeen = Date.parse(session.lastSeenAt);
      return !Number.isNaN(lastSeen) && lastSeen >= cutoff;
    })
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));

  return otherSessions[0];
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function formatOpenSessionLabel(session: OpenWorkspaceSession, otherSessionCount: number): string {
  const environmentLabel = session.environment === 'wsl'
    ? 'WSL'
    : session.environment.toUpperCase();
  const extraCount = Math.max(0, otherSessionCount - 1);
  const suffix = extraCount > 0 ? ` +${extraCount} more` : '';
  return `Open in ${environmentLabel} on ${session.hostName}${suffix}`;
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return 'heartbeat unknown';
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) {
    return 'heartbeat just now';
  }

  if (seconds < 60) {
    return `heartbeat ${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);
  return `heartbeat ${minutes}m ago`;
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
  const workspaceFile = vscode.workspace.workspaceFile?.scheme === 'file'
    ? vscode.workspace.workspaceFile.fsPath
    : undefined;

  try {
    const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, 'rev-parse', '--show-toplevel']);
    const repoRoot = stdout.trim();
    if (!repoRoot) {
      throw new Error('No git repository was found for the current workspace.');
    }

    return { repoRoot, workspaceRoot, workspaceFile };
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

async function promptForWorktreeMode(): Promise<WorktreeModeQuickPickItem['mode'] | undefined> {
  return vscode.window.showQuickPick<WorktreeModeQuickPickItem>([
    {
      label: 'Create new branch',
      description: 'Create a branch and worktree',
      mode: 'newBranch'
    },
    {
      label: 'Use existing branch',
      description: 'Add a worktree for a local branch',
      mode: 'existingBranch'
    }
  ], {
    title: 'Add New Worktree',
    placeHolder: 'Choose how to create the worktree',
    ignoreFocusOut: true
  }).then((item) => item?.mode);
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

async function promptForExistingBranch(repoRoot: string): Promise<string | undefined> {
  const branches = await listAvailableExistingBranches(repoRoot);
  return vscode.window.showQuickPick(branches, {
    title: 'Add New Worktree',
    placeHolder: 'Choose an existing local branch',
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

  const items = parseBranchQuickPickItems(stdout);

  if (items.length === 0) {
    throw new Error('No local or remote branches were found in the current repository.');
  }

  return items;
}

async function listAvailableExistingBranches(repoRoot: string): Promise<BranchQuickPickItem[]> {
  const [branchItems, checkedOutBranches] = await Promise.all([
    listLocalBranchItems(repoRoot),
    listCheckedOutLocalBranches(repoRoot)
  ]);
  const availableItems = branchItems.filter((item) => !checkedOutBranches.has(item.refName));

  if (availableItems.length === 0) {
    throw new Error('No local branches are available for a new worktree. Branches already checked out in a worktree are hidden.');
  }

  return availableItems;
}

async function listLocalBranchItems(repoRoot: string): Promise<BranchQuickPickItem[]> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repoRoot,
    'for-each-ref',
    '--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(subject)',
    'refs/heads'
  ]);

  return parseBranchQuickPickItems(stdout);
}

async function listCheckedOutLocalBranches(repoRoot: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  const branches = stdout
    .split('\n')
    .map((line) => /^branch refs\/heads\/(.+)$/.exec(line.trim())?.[1])
    .filter((branchName): branchName is string => Boolean(branchName));
  return new Set(branches);
}

function parseBranchQuickPickItems(stdout: string): BranchQuickPickItem[] {
  return stdout
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

function getSuggestedExistingBranchWorktreePath(workspaceRoot: string, branchName: string): string {
  return path.join(path.dirname(workspaceRoot), sanitizeForPathSegment(branchName));
}

function sanitizeForPathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'worktree';
}

function normalizeRemoteUrl(remoteUrl: string): string {
  let normalized = remoteUrl.trim().toLowerCase();
  normalized = normalized.replace(/^ssh:\/\//, '');
  normalized = normalized.replace(/^git@/, '');
  normalized = normalized.replace(/^https?:\/\//, '');
  normalized = normalized.replace(/:/, '/');
  normalized = normalized.replace(/\.git$/, '');
  return normalized;
}

function formatRemoteLabel(remoteUrl: string): string {
  const normalized = normalizeRemoteUrl(remoteUrl);
  const match = normalized.match(/([^/]+\/[^/]+)$/);
  return match?.[1] ?? remoteUrl;
}

async function getGitExtensionApi(): Promise<GitExtensionApi | undefined> {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    return undefined;
  }

  const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  if (!exports || typeof (exports as { getAPI?: unknown }).getAPI !== 'function') {
    return undefined;
  }

  try {
    return (exports as { getAPI(version: number): GitExtensionApi }).getAPI(1);
  } catch {
    return undefined;
  }
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

async function getStorageRootDir(context: vscode.ExtensionContext): Promise<string> {
  const overridePath = process.env.WORKSPACE_PICKER_STORAGE_ROOT;
  if (overridePath) {
    return overridePath;
  }

  const sharedWindowsPath = await getSharedWindowsStoragePath();
  if (sharedWindowsPath) {
    return sharedWindowsPath;
  }

  return context.globalStorageUri.fsPath;
}

async function getSharedWindowsStoragePath(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      return undefined;
    }

    return path.join(appData, 'Code', 'User', EXTENSION_STORAGE_DIR);
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

    return toWslPathFromWindows(path.join(windowsAppData, 'Code', 'User', EXTENSION_STORAGE_DIR));
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

function pathsMatch(left: string, right: string): boolean {
  if (isWindowsPath(left) || isWindowsPath(right)) {
    return left.toLowerCase() === right.toLowerCase();
  }

  return left === right;
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

function shouldLaunchInWindowsLocalSession(entry: KnownWorkspaceEntry): boolean {
  return isWslEnvironment() && entry.origin === 'windows' && isWindowsPath(entry.path);
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

async function openEntryInWindowsLocalSession(
  entry: KnownWorkspaceEntry,
  forceNewWindow: boolean
): Promise<void> {
  await runWindowsCodeCommand([
    forceNewWindow ? '--new-window' : '--reuse-window',
    entry.path
  ]);
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

import * as fs from 'fs/promises';
import * as path from 'path';

export type EntryKind = 'folder' | 'workspace';
export type EntryOrigin = 'windows' | 'wsl' | 'linux' | 'macos' | 'unknown';

export interface CachedGitInfo {
  repoName?: string;
  branch?: string;
  remoteGroupKey?: string;
  remoteLabel?: string;
}

export interface GitInfo {
  repoName: string;
  branch: string;
  stagedCount?: number;
  unstagedCount?: number;
  remoteGroupKey?: string;
  remoteLabel?: string;
}

export interface KnownWorkspaceEntry {
  id: string;
  path: string;
  kind: EntryKind;
  addedAt: string;
  origin: EntryOrigin;
  wslDistro?: string;
  cachedGitInfo?: CachedGitInfo;
}

export interface OpenWorkspaceSession {
  sessionId: string;
  processId: number;
  lastSeenAt: string;
  environment: EntryOrigin;
  hostName: string;
  appName?: string;
}

interface StoredData {
  version: 2;
  entries: KnownWorkspaceEntry[];
  groupOrder: string[];
}

interface StoreMetadata {
  version: number;
  entryOrder: string[];
  groupOrder: string[];
}

interface StoreState {
  entries: KnownWorkspaceEntry[];
  metadata: StoreMetadata;
}

interface StorePaths {
  rootDir: string;
  entriesDir: string;
  openSessionsDir: string;
  metadataFilePath: string;
  legacyFilePath: string;
}

export interface KnownWorkspaceStoreOptions {
  getStorageRootDir(): Promise<string>;
  detectOrigin(entryPath: string): EntryOrigin;
  detectWslDistro(entryPath: string): string | undefined;
  resolveEntryPath(entry: KnownWorkspaceEntry): Promise<string | undefined>;
}

const METADATA_FILE_NAME = 'metadata.json';
const ENTRIES_DIR_NAME = 'entries';
const OPEN_SESSIONS_DIR_NAME = 'open-sessions';
const ENTRY_FILE_EXTENSION = '.json';
const LEGACY_STORAGE_FILE_NAME = 'known-workspaces.json';
export const PERSISTENCE_VERSION = 3;

export class KnownWorkspaceStore {
  constructor(private readonly options: KnownWorkspaceStoreOptions) {}

  async list(): Promise<KnownWorkspaceEntry[]> {
    const state = await this.readState();
    return state.entries;
  }

  async getGroupOrder(): Promise<string[]> {
    const state = await this.readState();
    return state.metadata.groupOrder;
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

  async addUris(uris: Array<{ scheme: string; fsPath: string }>): Promise<void> {
    const state = await this.readState();
    const byPath = new Map(state.entries.map((entry) => [entry.path.toLowerCase(), entry]));
    const nextEntries = new Map(state.entries.map((entry) => [entry.id, entry]));
    const appendedIds: string[] = [];

    for (const uri of uris) {
      if (uri.scheme !== 'file') {
        continue;
      }

      const existing = byPath.get(uri.fsPath.toLowerCase());
      const kind: EntryKind = uri.fsPath.endsWith('.code-workspace') ? 'workspace' : 'folder';
      const entry = createEntry(uri.fsPath, kind, existing, this.options.detectOrigin, this.options.detectWslDistro);
      byPath.set(uri.fsPath.toLowerCase(), entry);
      nextEntries.set(entry.id, entry);

      if (!existing) {
        appendedIds.push(entry.id);
      }
    }

    await this.upsertEntries(Array.from(nextEntries.values()));
    await this.updateMetadata((metadata) => ({
      ...metadata,
      entryOrder: dedupeIds([
        ...metadata.entryOrder.filter((id) => nextEntries.has(id)),
        ...appendedIds
      ])
    }));
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const idSet = new Set(ids);
    await this.deleteEntryFiles(ids);
    await this.updateMetadata((metadata) => ({
      ...metadata,
      entryOrder: metadata.entryOrder.filter((id) => !idSet.has(id))
    }));
  }

  async reorder(ids: string[]): Promise<void> {
    await this.updateMetadata(async (metadata) => {
      const availableIds = (await this.readEntryFiles()).map((entry) => entry.id);
      return {
        ...metadata,
        entryOrder: reorderIds(ids, metadata.entryOrder, availableIds)
      };
    });
  }

  async reorderGroups(groupIds: string[]): Promise<void> {
    await this.updateMetadata((metadata) => ({
      ...metadata,
      groupOrder: reorderIds(groupIds, metadata.groupOrder, [])
    }));
  }

  async updateGitInfoCache(updates: Array<{ id: string; gitInfo?: GitInfo }>): Promise<boolean> {
    if (updates.length === 0) {
      return false;
    }

    const updateMap = new Map(updates.map((update) => [update.id, update.gitInfo]));
    const entries = await this.list();
    let changed = false;
    const nextEntries = entries.map((entry) => {
      if (!updateMap.has(entry.id)) {
        return entry;
      }

      const gitInfo = updateMap.get(entry.id);
      const nextCachedGitInfo = gitInfo
        ? {
            repoName: gitInfo.repoName,
            branch: gitInfo.branch,
            remoteGroupKey: gitInfo.remoteGroupKey,
            remoteLabel: gitInfo.remoteLabel
          }
        : undefined;

      if (JSON.stringify(entry.cachedGitInfo ?? null) === JSON.stringify(nextCachedGitInfo ?? null)) {
        return entry;
      }

      changed = true;
      return {
        ...entry,
        cachedGitInfo: nextCachedGitInfo
      };
    });

    if (!changed) {
      return false;
    }

    await this.upsertEntries(nextEntries);
    return true;
  }

  async updateGitInfoCacheIfChanged(id: string, gitInfo?: GitInfo): Promise<boolean> {
    return this.updateGitInfoCache([{ id, gitInfo }]);
  }

  async resolveEntryPath(entry: KnownWorkspaceEntry): Promise<string | undefined> {
    return this.options.resolveEntryPath(entry);
  }

  async listOpenSessionsByEntryIds(entryIds: string[]): Promise<Map<string, OpenWorkspaceSession[]>> {
    const idSet = new Set(entryIds);
    const sessions = await this.readOpenSessionFiles();
    const byEntryId = new Map<string, OpenWorkspaceSession[]>();

    for (const sessionRecord of sessions) {
      if (!idSet.has(sessionRecord.entryId)) {
        continue;
      }

      const existing = byEntryId.get(sessionRecord.entryId) ?? [];
      existing.push(sessionRecord.session);
      byEntryId.set(sessionRecord.entryId, existing);
    }

    return byEntryId;
  }

  async upsertOpenSession(entryId: string, session: OpenWorkspaceSession): Promise<void> {
    const paths = await this.getPaths();
    await fs.mkdir(paths.openSessionsDir, { recursive: true });
    await fs.writeFile(
      this.getOpenSessionFilePath(entryId, session.sessionId, paths),
      `${JSON.stringify(session, null, 2)}\n`,
      'utf8'
    );
  }

  async removeOpenSession(entryId: string, sessionId: string): Promise<void> {
    const paths = await this.getPaths();
    await this.safeUnlink(this.getOpenSessionFilePath(entryId, sessionId, paths));
  }

  async pruneOpenSessions(maxAgeMs: number, now = Date.now()): Promise<void> {
    const paths = await this.getPaths();
    const sessions = await this.readOpenSessionFiles(paths);
    const staleSessions = sessions.filter((sessionRecord) => {
      const lastSeen = Date.parse(sessionRecord.session.lastSeenAt);
      return Number.isNaN(lastSeen) || now - lastSeen > maxAgeMs;
    });

    await Promise.all(staleSessions.map((sessionRecord) => this.safeUnlink(
      this.getOpenSessionFilePath(sessionRecord.entryId, sessionRecord.session.sessionId, paths)
    )));
  }

  private async readState(): Promise<StoreState> {
    const paths = await this.getPaths();
    let metadata = await this.readMetadata(paths);
    let entries = await this.readEntryFiles(paths);
    const legacyData = await this.readLegacyData(paths);

    if (legacyData.entries.length > 0) {
      const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
      const missingLegacyEntries = legacyData.entries.filter((entry) => !entriesById.has(entry.id));

      if (missingLegacyEntries.length > 0) {
        entries = [...entries, ...missingLegacyEntries];
        await this.upsertEntries(missingLegacyEntries, paths);
      }

      metadata = {
        version: PERSISTENCE_VERSION,
        entryOrder: dedupeIds([
          ...metadata.entryOrder,
          ...missingLegacyEntries.map((entry) => entry.id)
        ]),
        groupOrder: metadata.groupOrder.length > 0 ? metadata.groupOrder : legacyData.groupOrder
      };
      await this.updateMetadata(() => metadata, paths);
      await this.safeUnlink(paths.legacyFilePath);
    }

    const orderedEntries = orderEntries(entries, metadata.entryOrder);
    return {
      entries: orderedEntries,
      metadata: {
        ...metadata,
        entryOrder: dedupeIds([
          ...metadata.entryOrder.filter((id) => orderedEntries.some((entry) => entry.id === id)),
          ...orderedEntries.map((entry) => entry.id)
        ])
      }
    };
  }

  private async readMetadata(paths?: StorePaths): Promise<StoreMetadata> {
    const resolvedPaths = paths ?? await this.getPaths();

    try {
      const raw = await fs.readFile(resolvedPaths.metadataFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreMetadata>;
      return migrateMetadata(parsed);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        const legacyData = await this.readLegacyData(resolvedPaths);
        return migrateMetadata({
          version: 2,
          entryOrder: legacyData.entries.map((entry) => entry.id),
          groupOrder: legacyData.groupOrder
        });
      }

      throw error;
    }
  }

  private async readEntryFiles(paths?: StorePaths): Promise<KnownWorkspaceEntry[]> {
    const resolvedPaths = paths ?? await this.getPaths();

    try {
      const dirEntries = await fs.readdir(resolvedPaths.entriesDir, { withFileTypes: true });
      const entries = await Promise.all(dirEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(ENTRY_FILE_EXTENSION))
        .map(async (entry) => {
          const raw = await fs.readFile(path.join(resolvedPaths.entriesDir, entry.name), 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          return isKnownWorkspaceEntry(parsed) ? parsed : undefined;
        }));

      return entries.filter((entry): entry is KnownWorkspaceEntry => Boolean(entry));
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  private async readLegacyData(paths?: StorePaths): Promise<StoredData> {
    const resolvedPaths = paths ?? await this.getPaths();

    try {
      const raw = await fs.readFile(resolvedPaths.legacyFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredData>;
      return {
        version: 2,
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isKnownWorkspaceEntry) : [],
        groupOrder: Array.isArray(parsed.groupOrder)
          ? parsed.groupOrder.filter((value): value is string => typeof value === 'string')
          : []
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return {
          version: 2,
          entries: [],
          groupOrder: []
        };
      }

      throw error;
    }
  }

  private async readOpenSessionFiles(
    paths?: StorePaths
  ): Promise<Array<{ entryId: string; session: OpenWorkspaceSession }>> {
    const resolvedPaths = paths ?? await this.getPaths();

    try {
      const dirEntries = await fs.readdir(resolvedPaths.openSessionsDir, { withFileTypes: true });
      const sessions = await Promise.all(dirEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(ENTRY_FILE_EXTENSION))
        .map(async (entry) => {
          const parsedName = parseOpenSessionFileName(entry.name);
          if (!parsedName) {
            return undefined;
          }

          const raw = await fs.readFile(path.join(resolvedPaths.openSessionsDir, entry.name), 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (!isOpenWorkspaceSession(parsed)) {
            return undefined;
          }

          return {
            entryId: parsedName.entryId,
            session: parsed
          };
        }));

      return sessions.filter((session): session is { entryId: string; session: OpenWorkspaceSession } => Boolean(session));
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  private async upsertEntries(entries: KnownWorkspaceEntry[], paths?: StorePaths): Promise<void> {
    const resolvedPaths = paths ?? await this.getPaths();

    await fs.mkdir(resolvedPaths.entriesDir, { recursive: true });

    await Promise.all(entries.map((entry) => fs.writeFile(
      this.getEntryFilePath(entry.id, resolvedPaths),
      `${JSON.stringify(entry, null, 2)}\n`,
      'utf8'
    )));
  }

  private async deleteEntryFiles(ids: string[], paths?: StorePaths): Promise<void> {
    const resolvedPaths = paths ?? await this.getPaths();
    await Promise.all(ids.map((id) => this.safeUnlink(this.getEntryFilePath(id, resolvedPaths))));
  }

  private async updateMetadata(
    updater: (metadata: StoreMetadata) => StoreMetadata | Promise<StoreMetadata>,
    paths?: StorePaths
  ): Promise<void> {
    const resolvedPaths = paths ?? await this.getPaths();
    const nextMetadata = await updater(await this.readMetadata(resolvedPaths));
    const sanitized: StoreMetadata = {
      version: PERSISTENCE_VERSION,
      entryOrder: dedupeIds(nextMetadata.entryOrder),
      groupOrder: dedupeIds(nextMetadata.groupOrder)
    };
    await fs.mkdir(resolvedPaths.rootDir, { recursive: true });
    await fs.writeFile(resolvedPaths.metadataFilePath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  }

  private async getPaths(): Promise<StorePaths> {
    const rootDir = await this.options.getStorageRootDir();
    return {
      rootDir,
      entriesDir: path.join(rootDir, ENTRIES_DIR_NAME),
      openSessionsDir: path.join(rootDir, OPEN_SESSIONS_DIR_NAME),
      metadataFilePath: path.join(rootDir, METADATA_FILE_NAME),
      legacyFilePath: path.join(rootDir, LEGACY_STORAGE_FILE_NAME)
    };
  }

  private getEntryFilePath(id: string, paths: StorePaths): string {
    return path.join(paths.entriesDir, `${id}${ENTRY_FILE_EXTENSION}`);
  }

  private getOpenSessionFilePath(entryId: string, sessionId: string, paths: StorePaths): string {
    return path.join(paths.openSessionsDir, `${entryId}__${sessionId}${ENTRY_FILE_EXTENSION}`);
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export function isKnownWorkspaceEntry(value: unknown): value is KnownWorkspaceEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<KnownWorkspaceEntry>;
  return typeof candidate.id === 'string'
    && typeof candidate.path === 'string'
    && (candidate.kind === 'folder' || candidate.kind === 'workspace')
    && typeof candidate.addedAt === 'string'
    && typeof candidate.origin === 'string'
    && (candidate.cachedGitInfo === undefined || isCachedGitInfo(candidate.cachedGitInfo));
}

export function isOpenWorkspaceSession(value: unknown): value is OpenWorkspaceSession {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<OpenWorkspaceSession>;
  return typeof candidate.sessionId === 'string'
    && typeof candidate.processId === 'number'
    && typeof candidate.lastSeenAt === 'string'
    && typeof candidate.environment === 'string'
    && typeof candidate.hostName === 'string'
    && (candidate.appName === undefined || typeof candidate.appName === 'string');
}

export function isCachedGitInfo(value: unknown): value is CachedGitInfo {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CachedGitInfo>;
  return (candidate.repoName === undefined || typeof candidate.repoName === 'string')
    && (candidate.branch === undefined || typeof candidate.branch === 'string')
    && (candidate.remoteGroupKey === undefined || typeof candidate.remoteGroupKey === 'string')
    && (candidate.remoteLabel === undefined || typeof candidate.remoteLabel === 'string');
}

export function createEntry(
  entryPath: string,
  kind: EntryKind,
  existing: KnownWorkspaceEntry | undefined,
  detectOriginValue: (entryPath: string) => EntryOrigin,
  detectWslDistroValue: (entryPath: string) => string | undefined
): KnownWorkspaceEntry {
  return {
    id: createEntryId(entryPath),
    path: entryPath,
    kind,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    origin: detectOriginValue(entryPath),
    wslDistro: detectWslDistroValue(entryPath),
    cachedGitInfo: existing?.cachedGitInfo
  };
}

export function createEntryId(entryPath: string): string {
  const normalized = entryPath.toLowerCase();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
    hash |= 0;
  }
  return `entry-${Math.abs(hash)}`;
}

export function orderEntries(entries: KnownWorkspaceEntry[], entryOrder: string[]): KnownWorkspaceEntry[] {
  const orderMap = new Map(entryOrder.map((id, index) => [id, index]));
  return [...entries].sort((left, right) => {
    const leftIndex = orderMap.has(left.id) ? orderMap.get(left.id)! : Number.MAX_SAFE_INTEGER;
    const rightIndex = orderMap.has(right.id) ? orderMap.get(right.id)! : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    if (left.addedAt !== right.addedAt) {
      return left.addedAt.localeCompare(right.addedAt);
    }

    return left.path.localeCompare(right.path);
  });
}

export function reorderIds(prioritizedIds: string[], existingIds: string[], availableIds: string[]): string[] {
  const availableIdSet = new Set(availableIds);
  const mergedIds = availableIds.length > 0
    ? dedupeIds([
        ...existingIds.filter((id) => availableIdSet.has(id)),
        ...availableIds
      ])
    : dedupeIds(existingIds);
  const prioritized = prioritizedIds.filter((id) => mergedIds.includes(id));
  const prioritizedSet = new Set(prioritized);
  return [...prioritized, ...mergedIds.filter((id) => !prioritizedSet.has(id))];
}

function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  return result;
}

function parseOpenSessionFileName(fileName: string): { entryId: string; sessionId: string } | undefined {
  if (!fileName.endsWith(ENTRY_FILE_EXTENSION)) {
    return undefined;
  }

  const stem = fileName.slice(0, -ENTRY_FILE_EXTENSION.length);
  const separatorIndex = stem.indexOf('__');
  if (separatorIndex < 0) {
    return undefined;
  }

  return {
    entryId: stem.slice(0, separatorIndex),
    sessionId: stem.slice(separatorIndex + 2)
  };
}

function migrateMetadata(value: Partial<StoreMetadata>): StoreMetadata {
  const normalizedVersion = typeof value.version === 'number' ? value.version : PERSISTENCE_VERSION;
  const entryOrder = Array.isArray(value.entryOrder)
    ? value.entryOrder.filter((entryId): entryId is string => typeof entryId === 'string')
    : [];
  const groupOrder = Array.isArray(value.groupOrder)
    ? value.groupOrder.filter((groupId): groupId is string => typeof groupId === 'string')
    : [];

  switch (normalizedVersion) {
    case PERSISTENCE_VERSION:
      return {
        version: PERSISTENCE_VERSION,
        entryOrder,
        groupOrder
      };
    default:
      // Future persistence upgrades should land here as explicit migrations
      // from older metadata versions into the current shape.
      return {
        version: PERSISTENCE_VERSION,
        entryOrder,
        groupOrder
      };
  }
}

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KnownWorkspaceStore,
  PERSISTENCE_VERSION,
  createEntryId,
  orderEntries,
  reorderIds,
  type KnownWorkspaceEntry
} from './store';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('orderEntries', () => {
  it('keeps metadata order first and sorts the rest deterministically', () => {
    const entries: KnownWorkspaceEntry[] = [
      createTestEntry('/repo/zeta', '2024-01-03T00:00:00.000Z'),
      createTestEntry('/repo/alpha', '2024-01-01T00:00:00.000Z'),
      createTestEntry('/repo/beta', '2024-01-02T00:00:00.000Z')
    ];

    const ordered = orderEntries(entries, [entries[2].id]);

    expect(ordered.map((entry) => entry.path)).toEqual([
      '/repo/beta',
      '/repo/alpha',
      '/repo/zeta'
    ]);
  });
});

describe('reorderIds', () => {
  it('moves prioritized ids to the front and preserves the rest', () => {
    expect(reorderIds(['c', 'a'], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('KnownWorkspaceStore', () => {
  it('stores each entry in its own file and keeps metadata separate', async () => {
    const { store, rootDir } = await createStore();

    await store.addUris([
      { scheme: 'file', fsPath: '/repo/one' },
      { scheme: 'file', fsPath: '/repo/two.code-workspace' }
    ]);

    const entries = await store.list();
    expect(entries).toHaveLength(2);

    const entryFiles = await fs.readdir(path.join(rootDir, 'entries'));
    expect(entryFiles.sort()).toEqual(entries.map((entry) => `${entry.id}.json`).sort());

    const metadata = JSON.parse(await fs.readFile(path.join(rootDir, 'metadata.json'), 'utf8')) as { version: number; entryOrder: string[] };
    expect(metadata.version).toBe(PERSISTENCE_VERSION);
    expect(metadata.entryOrder).toEqual(entries.map((entry) => entry.id));
  });

  it('migrates legacy single-file storage on first read', async () => {
    const { store, rootDir } = await createStore();
    const legacyEntry = createTestEntry('/legacy/project', '2024-02-01T00:00:00.000Z');

    await fs.writeFile(path.join(rootDir, 'known-workspaces.json'), `${JSON.stringify({
      version: 2,
      entries: [legacyEntry],
      groupOrder: ['remote/a']
    }, null, 2)}\n`);

    const entries = await store.list();

    expect(entries).toEqual([legacyEntry]);
    await expect(fs.access(path.join(rootDir, 'entries', `${legacyEntry.id}.json`))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, 'metadata.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, 'known-workspaces.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const metadata = JSON.parse(await fs.readFile(path.join(rootDir, 'metadata.json'), 'utf8')) as { version: number; entryOrder: string[]; groupOrder: string[] };
    expect(metadata.version).toBe(PERSISTENCE_VERSION);
    expect(metadata.entryOrder).toEqual([legacyEntry.id]);
    expect(metadata.groupOrder).toEqual(['remote/a']);
  });

  it('updates git info without removing unrelated entries', async () => {
    const { store } = await createStore();

    await store.addUris([
      { scheme: 'file', fsPath: '/repo/one' },
      { scheme: 'file', fsPath: '/repo/two' }
    ]);

    const entries = await store.list();
    const changed = await store.updateGitInfoCacheIfChanged(entries[0].id, {
      repoName: 'one',
      branch: 'main',
      remoteGroupKey: 'owner/repo',
      remoteLabel: 'owner/repo'
    });

    expect(changed).toBe(true);
    const refreshed = await store.list();
    expect(refreshed).toHaveLength(2);
    expect(refreshed.find((entry) => entry.id === entries[0].id)?.cachedGitInfo).toMatchObject({
      repoName: 'one',
      branch: 'main'
    });
    expect(refreshed.find((entry) => entry.id === entries[1].id)?.cachedGitInfo).toBeUndefined();
  });

  it('does not delete entries written by another instance while updating one entry', async () => {
    const { store, rootDir } = await createStore();

    await store.addUris([{ scheme: 'file', fsPath: '/repo/one' }]);
    const externalEntry = createTestEntry('/repo/external', '2024-03-01T00:00:00.000Z');
    await fs.mkdir(path.join(rootDir, 'entries'), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, 'entries', `${externalEntry.id}.json`),
      `${JSON.stringify(externalEntry, null, 2)}\n`
    );

    const entries = await store.list();
    await store.updateGitInfoCacheIfChanged(entries[0].id, {
      repoName: 'one',
      branch: 'main'
    });

    const refreshed = await store.list();
    expect(refreshed.map((entry) => entry.id)).toContain(externalEntry.id);
  });

  it('keeps externally added entries when reordering with stale metadata', async () => {
    const { store, rootDir } = await createStore();

    await store.addUris([
      { scheme: 'file', fsPath: '/repo/one' },
      { scheme: 'file', fsPath: '/repo/two' }
    ]);

    const externalEntry = createTestEntry('/repo/external', '2024-04-01T00:00:00.000Z');
    await fs.mkdir(path.join(rootDir, 'entries'), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, 'entries', `${externalEntry.id}.json`),
      `${JSON.stringify(externalEntry, null, 2)}\n`
    );

    const currentEntries = await store.list();
    await store.reorder([currentEntries[1].id, currentEntries[0].id]);

    const refreshed = await store.list();
    expect(refreshed.map((entry) => entry.id)).toEqual([
      currentEntries[1].id,
      currentEntries[0].id,
      externalEntry.id
    ]);
  });

  it('stores open workspace heartbeats in separate session files', async () => {
    const { store, rootDir } = await createStore();

    await store.addUris([{ scheme: 'file', fsPath: '/repo/one' }]);
    const [entry] = await store.list();

    await store.upsertOpenSession(entry.id, {
      sessionId: 'session-a',
      processId: 101,
      lastSeenAt: '2024-05-01T00:00:00.000Z',
      environment: 'linux',
      hostName: 'devbox',
      appName: 'Visual Studio Code'
    });
    await store.upsertOpenSession(entry.id, {
      sessionId: 'session-b',
      processId: 202,
      lastSeenAt: '2024-05-01T00:00:10.000Z',
      environment: 'windows',
      hostName: 'workstation',
      appName: 'Visual Studio Code'
    });

    const sessionsByEntryId = await store.listOpenSessionsByEntryIds([entry.id]);
    expect(sessionsByEntryId.get(entry.id)).toHaveLength(2);

    const openSessionFiles = await fs.readdir(path.join(rootDir, 'open-sessions'));
    expect(openSessionFiles.sort()).toEqual([
      `${entry.id}__session-a.json`,
      `${entry.id}__session-b.json`
    ]);
  });

  it('migrates legacy entries into a partial new layout without losing either side', async () => {
    const { store, rootDir } = await createStore();
    const legacyEntry = createTestEntry('/legacy/project', '2024-02-01T00:00:00.000Z');
    const existingNewEntry = createTestEntry('/new-layout/project', '2024-03-01T00:00:00.000Z');

    await fs.mkdir(path.join(rootDir, 'entries'), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, 'entries', `${existingNewEntry.id}.json`),
      `${JSON.stringify(existingNewEntry, null, 2)}\n`
    );
    await fs.writeFile(path.join(rootDir, 'known-workspaces.json'), `${JSON.stringify({
      version: 2,
      entries: [legacyEntry],
      groupOrder: ['remote/legacy']
    }, null, 2)}\n`);
    await fs.writeFile(path.join(rootDir, 'metadata.json'), `${JSON.stringify({
      version: PERSISTENCE_VERSION,
      entryOrder: [existingNewEntry.id],
      groupOrder: ['remote/new']
    }, null, 2)}\n`);

    const entries = await store.list();

    expect(entries.map((entry) => entry.id)).toEqual([existingNewEntry.id, legacyEntry.id]);

    const metadata = JSON.parse(await fs.readFile(path.join(rootDir, 'metadata.json'), 'utf8')) as { version: number; entryOrder: string[]; groupOrder: string[] };
    expect(metadata.version).toBe(PERSISTENCE_VERSION);
    expect(metadata.entryOrder).toEqual([existingNewEntry.id, legacyEntry.id]);
    expect(metadata.groupOrder).toEqual(['remote/new']);
    await expect(fs.access(path.join(rootDir, 'known-workspaces.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('normalizes older metadata versions to the current persistence version', async () => {
    const { store, rootDir } = await createStore();
    const entry = createTestEntry('/repo/versioned', '2024-06-01T00:00:00.000Z');

    await fs.mkdir(path.join(rootDir, 'entries'), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, 'entries', `${entry.id}.json`),
      `${JSON.stringify(entry, null, 2)}\n`
    );
    await fs.writeFile(path.join(rootDir, 'metadata.json'), `${JSON.stringify({
      version: 1,
      entryOrder: [entry.id],
      groupOrder: ['remote/versioned']
    }, null, 2)}\n`);

    const entries = await store.list();
    expect(entries.map((candidate) => candidate.id)).toEqual([entry.id]);

    await store.reorder([entry.id]);

    const metadata = JSON.parse(await fs.readFile(path.join(rootDir, 'metadata.json'), 'utf8')) as { version: number; entryOrder: string[]; groupOrder: string[] };
    expect(metadata.version).toBe(PERSISTENCE_VERSION);
    expect(metadata.entryOrder).toEqual([entry.id]);
    expect(metadata.groupOrder).toEqual(['remote/versioned']);
  });

  it('prunes stale open workspace heartbeats without touching fresh ones', async () => {
    const { store } = await createStore();

    await store.addUris([{ scheme: 'file', fsPath: '/repo/one' }]);
    const [entry] = await store.list();

    await store.upsertOpenSession(entry.id, {
      sessionId: 'stale',
      processId: 1,
      lastSeenAt: '2024-05-01T00:00:00.000Z',
      environment: 'linux',
      hostName: 'devbox'
    });
    await store.upsertOpenSession(entry.id, {
      sessionId: 'fresh',
      processId: 2,
      lastSeenAt: '2024-05-01T00:00:25.000Z',
      environment: 'linux',
      hostName: 'devbox'
    });

    await store.pruneOpenSessions(20_000, Date.parse('2024-05-01T00:00:30.000Z'));

    const sessionsByEntryId = await store.listOpenSessionsByEntryIds([entry.id]);
    expect(sessionsByEntryId.get(entry.id)).toEqual([
      expect.objectContaining({ sessionId: 'fresh' })
    ]);
  });
});

async function createStore(): Promise<{ store: KnownWorkspaceStore; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-picker-'));
  tempDirs.push(rootDir);
  return {
    rootDir,
    store: new KnownWorkspaceStore({
      getStorageRootDir: async () => rootDir,
      detectOrigin: () => 'linux',
      detectWslDistro: () => undefined,
      resolveEntryPath: async (entry) => entry.path
    })
  };
}

function createTestEntry(entryPath: string, addedAt: string): KnownWorkspaceEntry {
  return {
    id: createEntryId(entryPath),
    path: entryPath,
    kind: entryPath.endsWith('.code-workspace') ? 'workspace' : 'folder',
    addedAt,
    origin: 'linux'
  };
}

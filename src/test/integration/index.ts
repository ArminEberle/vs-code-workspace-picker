import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

interface WorkspacePickerExtensionApi {
  listEntries(): Promise<Array<{ id: string; path: string }>>;
  getGroupOrder(): Promise<string[]>;
  getStorageRootDir(): Promise<string>;
  addEntriesForTests(paths: string[]): Promise<void>;
}

const EXTENSION_ID = 'ArminEberle.vs-code-workspace-picker';

export async function run(): Promise<void> {
  await testAddCurrentPersistsAsSeparateEntryFile();
}

async function testAddCurrentPersistsAsSeparateEntryFile(): Promise<void> {
  const extension = vscode.extensions.getExtension<WorkspacePickerExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} must be installed in the test host`);

  const api = await extension.activate();
  const expectedPath = process.env.WORKSPACE_PICKER_TEST_WORKSPACE;
  assert.ok(expectedPath, 'Integration test workspace path must be provided');

  await vscode.commands.executeCommand('workspacePicker.openKnown');
  await api.addEntriesForTests([expectedPath]);

  const entry = await waitFor(async () => {
    const entries = await api.listEntries();
    return entries.find((candidate) => candidate.path === expectedPath);
  }, 'workspace entry to appear after test add');

  const storageRootDir = await api.getStorageRootDir();
  const entryFilePath = path.join(storageRootDir, 'entries', `${entry.id}.json`);
  const metadataFilePath = path.join(storageRootDir, 'metadata.json');

  await assertFileExists(entryFilePath);
  await assertFileExists(metadataFilePath);

  const entryData = JSON.parse(await fs.readFile(entryFilePath, 'utf8')) as { path: string };
  const metadata = JSON.parse(await fs.readFile(metadataFilePath, 'utf8')) as { entryOrder: string[] };

  assert.equal(entryData.path, expectedPath);
  assert.ok(metadata.entryOrder.includes(entry.id), 'metadata should include the newly added entry');
}

async function waitFor<T>(
  producer: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 10000
): Promise<T> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = await producer();
    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function assertFileExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Expected file to exist: ${filePath}`);
  }
}

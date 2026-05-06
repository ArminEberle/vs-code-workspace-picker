import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { test } from '@playwright/test';
import {
  clickViewButton,
  closeVsCodeApp,
  expectTextInView,
  launchVsCodeApp,
  requireVsCodeExecutable,
  runCommand
} from './helpers/vscodeApp';

const fixtureWorkspacePath = path.resolve(__dirname, '../../test-fixtures/basic-workspace');
const workspaceLabel = path.basename(fixtureWorkspacePath);

test.describe('Workspace Picker UI', () => {
  test.beforeAll(async () => {
    await requireVsCodeExecutable();
  });

  test('shows the current workspace after clicking Add This', async () => {
    const storageRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-picker-ui-store-'));
    const session = await launchVsCodeApp({
      storageRootDir,
      workspacePath: fixtureWorkspacePath
    });

    try {
      await runCommand(session.page, 'Focus Known Workspaces');
      await clickViewButton(session.page, 'Add This');
      await expectTextInView(session.page, workspaceLabel);
    } finally {
      await closeVsCodeApp(session);
      await fs.rm(storageRootDir, { recursive: true, force: true });
    }
  });

  test('syncs a newly added workspace into a second VS Code instance after refresh', async () => {
    const storageRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-picker-ui-shared-store-'));
    const firstSession = await launchVsCodeApp({
      storageRootDir,
      workspacePath: fixtureWorkspacePath
    });
    const secondSession = await launchVsCodeApp({
      storageRootDir,
      workspacePath: fixtureWorkspacePath
    });

    try {
      await runCommand(firstSession.page, 'Focus Known Workspaces');
      await runCommand(secondSession.page, 'Focus Known Workspaces');

      await clickViewButton(firstSession.page, 'Add This');
      await clickViewButton(secondSession.page, 'Refresh');

      await expectTextInView(secondSession.page, workspaceLabel);
    } finally {
      await closeVsCodeApp(firstSession);
      await closeVsCodeApp(secondSession);
      await fs.rm(storageRootDir, { recursive: true, force: true });
    }
  });
});

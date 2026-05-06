import { execFile } from 'child_process';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as pathWin32 from 'path/win32';
import { promisify } from 'util';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';

interface LaunchOptions {
  storageRootDir: string;
  workspacePath: string;
}

export interface VsCodeAppSession {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../../..');
let cachedExecutablePath: string | undefined;

export async function requireVsCodeExecutable(): Promise<string> {
  if (isWslEnvironment()) {
    throw new Error(
      'Playwright Electron UI tests are not supported from inside WSL against Windows VS Code. Run `npm run test:ui` from Windows PowerShell/CMD, or use a native Linux desktop VS Code build.'
    );
  }

  const resolvedPath = await resolveVsCodeExecutablePath();
  if (!resolvedPath) {
    throw new Error(
      'Could not find a desktop VS Code executable. Set VSCODE_EXECUTABLE_PATH explicitly, or install Windows VS Code in a standard location for WSL auto-detection.'
    );
  }

  return resolvedPath;
}

export async function launchVsCodeApp(options: LaunchOptions): Promise<VsCodeAppSession> {
  const resolvedExecutablePath = await requireVsCodeExecutable();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-picker-ui-userdata-'));
  const app = await electron.launch({
    executablePath: resolvedExecutablePath,
    args: [
      `--extensionDevelopmentPath=${repoRoot}`,
      `--user-data-dir=${userDataDir}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      options.workspacePath
    ],
    env: {
      ...process.env,
      WORKSPACE_PICKER_STORAGE_ROOT: options.storageRootDir
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userDataDir };
}

export async function closeVsCodeApp(session: VsCodeAppSession): Promise<void> {
  await session.app.close();
  await fs.rm(session.userDataDir, { recursive: true, force: true });
}

export async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
  const input = page.locator('.quick-input-widget input').first();
  await expect(input).toBeVisible({ timeout: 15000 });
  await input.fill(`>${label}`);
  await page.keyboard.press('Enter');
}

export async function clickViewButton(page: Page, label: string): Promise<void> {
  const frame = await findFrameWithButton(page, label);
  await frame.getByRole('button', { name: label }).click();
}

export async function expectTextInView(page: Page, text: string): Promise<void> {
  const frame = await findFrameContainingText(page, text);
  await expect(frame.getByText(text, { exact: false })).toBeVisible();
}

async function findFrameWithButton(page: Page, label: string): Promise<Page | import('@playwright/test').Frame> {
  return waitForFrame(page, async (frame) => {
    const button = frame.getByRole('button', { name: label });
    return await button.count() > 0 ? frame : undefined;
  });
}

async function findFrameContainingText(page: Page, text: string): Promise<Page | import('@playwright/test').Frame> {
  return waitForFrame(page, async (frame) => {
    const locator = frame.getByText(text, { exact: false });
    return await locator.count() > 0 ? frame : undefined;
  });
}

async function waitForFrame(
  page: Page,
  matcher: (frame: Page | import('@playwright/test').Frame) => Promise<Page | import('@playwright/test').Frame | undefined>,
  timeoutMs = 15000
): Promise<Page | import('@playwright/test').Frame> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const frames = [page, ...page.frames()];
    for (const frame of frames) {
      const matched = await matcher(frame);
      if (matched) {
        return matched;
      }
    }

    await page.waitForTimeout(200);
  }

  throw new Error('Timed out waiting for the Workspace Picker webview content.');
}

async function resolveVsCodeExecutablePath(): Promise<string | undefined> {
  if (cachedExecutablePath && fsSync.existsSync(cachedExecutablePath)) {
    return cachedExecutablePath;
  }

  const overridePath = process.env.VSCODE_EXECUTABLE_PATH;
  if (overridePath && await pathExists(overridePath)) {
    cachedExecutablePath = overridePath;
    return cachedExecutablePath;
  }

  if (isWslEnvironment()) {
    const windowsLocalAppData = await getWindowsLocalAppData();
    const candidates = windowsLocalAppData
      ? [
          toWslPathFromWindows(pathWin32.join(windowsLocalAppData, 'Programs', 'Microsoft VS Code', 'Code.exe')),
          toWslPathFromWindows(pathWin32.join(windowsLocalAppData, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'))
        ]
      : await findWslFallbackCandidates();

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        cachedExecutablePath = candidate;
        return cachedExecutablePath;
      }
    }
  }

  return undefined;
}

function isWslEnvironment(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

async function getWindowsLocalAppData(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('cmd.exe', ['/c', 'echo', '%LOCALAPPDATA%']);
    const value = stdout.trim();
    return value && !value.includes('%LOCALAPPDATA%') ? value : undefined;
  } catch {
    return undefined;
  }
}

async function findWslFallbackCandidates(): Promise<string[]> {
  try {
    const userRoots = await fs.readdir('/mnt/c/Users', { withFileTypes: true });
    return userRoots
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const basePath = path.join('/mnt/c/Users', entry.name, 'AppData/Local/Programs');
        return [
          path.join(basePath, 'Microsoft VS Code', 'Code.exe'),
          path.join(basePath, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')
        ];
      });
  } catch {
    return [];
  }
}

function toWslPathFromWindows(targetPath: string): string {
  const normalized = targetPath.replaceAll('\\', '/');
  const driveLetter = normalized[0]?.toLowerCase();
  return `/mnt/${driveLetter}${normalized.slice(2)}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

import * as fs from 'fs/promises';
import * as pathWin32 from 'path/win32';
import { execFile } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { runTests } from '@vscode/test-electron';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDevelopmentPath = repoRoot;
const extensionTestsPath = path.join(repoRoot, 'dist', 'test', 'integration');
const testWorkspacePath = path.join(repoRoot, 'test-fixtures', 'basic-workspace');
const vscodeExecutablePath = await requireVsCodeExecutablePath();

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error('Integration tests need a graphical Linux session or Xvfb. DISPLAY is not set in this environment.');
  process.exit(1);
}

await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath,
  extensionTestsPath,
  extensionTestsEnv: {
    WORKSPACE_PICKER_TEST_WORKSPACE: testWorkspacePath
  }
});

async function requireVsCodeExecutablePath() {
  const resolvedPath = await resolveVsCodeExecutablePath();
  if (!resolvedPath) {
    console.error(
      'Could not find a desktop VS Code executable. Set VSCODE_EXECUTABLE_PATH explicitly, or install Windows VS Code in a standard location for WSL auto-detection.'
    );
    process.exit(1);
  }

  return resolvedPath;
}

async function resolveVsCodeExecutablePath() {
  const overridePath = process.env.VSCODE_EXECUTABLE_PATH;
  if (overridePath && await pathExists(overridePath)) {
    return overridePath;
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
        return candidate;
      }
    }
  }

  return undefined;
}

function isWslEnvironment() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

async function getWindowsLocalAppData() {
  try {
    const { stdout } = await execFileAsync('cmd.exe', ['/c', 'echo', '%LOCALAPPDATA%']);
    const value = stdout.trim();
    return value && !value.includes('%LOCALAPPDATA%') ? value : undefined;
  } catch {
    return undefined;
  }
}

async function findWslFallbackCandidates() {
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

function toWslPathFromWindows(targetPath) {
  const normalized = targetPath.replaceAll('\\', '/');
  const driveLetter = normalized[0]?.toLowerCase();
  return `/mnt/${driveLetter}${normalized.slice(2)}`;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

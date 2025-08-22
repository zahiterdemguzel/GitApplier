import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';

function exists(p: string) {
  try { return fs.existsSync(p); } catch { return false; }
}

function findGitBashPath(): string | null {
  const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
  const configured = cfg.get<string>('gitBashPath');
  const candidates = [
    configured,
    'C:\\\Program Files\\Git\\bin\\bash.exe',
    'C:\\\Program Files\\Git\\git-bash.exe',
    'C:\\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\\Program Files (x86)\\Git\\bin\\bash.exe'
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

function createTerminal(cwd: string, name: string): vscode.Terminal | null {
  if (os.platform() === 'win32') {
    const bashPath = findGitBashPath();
    if (!bashPath) {
      vscode.window.showErrorMessage(
        'Git Bash not found. Set "Git Apply From Clipboard › Git Bash Path" to your bash.exe (e.g., C:\\Program Files\\Git\\bin\\bash.exe).'
      );
      return null;
    }

    return vscode.window.createTerminal({
      name,
      cwd,
      shellPath: bashPath,
      shellArgs: ['--login', '-i']
    });
  } else {
    return vscode.window.createTerminal({ name, cwd });
  }
}

export function activate(context: vscode.ExtensionContext) {
  const applyCmd = 'gitApplyFromClipboard.run';
  // Command identifier for performing a hard reset on the current repo
  const resetHardCmd = 'gitApplyFromClipboard.resetHard';

  const runApply = vscode.commands.registerCommand(applyCmd, async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Open a folder or workspace first to run git apply.');
      return;
    }
    const cwd = folders[0].uri.fsPath;

    const clip = (await vscode.env.clipboard.readText()).trim();
    if (!clip) {
      vscode.window.showWarningMessage('Clipboard is empty.');
      return;
    }

    const containsGitApply = /\bgit\s+apply\b/i.test(clip);
    if (!containsGitApply) {
      const choice = await vscode.window.showWarningMessage(
        'Clipboard does not contain a "git apply" command.',
        'Run anyway',
        'Cancel'
      );
      if (choice !== 'Run anyway') return;
    }

    const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
    const autoReset = cfg.get<boolean>('autoResetOnApply', false);

    const terminal = createTerminal(cwd, 'Git Apply (Git Bash)');
    if (!terminal) return;

    terminal.show(true);
    if (autoReset) {
      terminal.sendText('git reset --hard', true);
    }
    terminal.sendText(clip, false);
    terminal.sendText('', true);
  });

  // Execute `git reset --hard` after explicit confirmation from the user
  const runHardReset = vscode.commands.registerCommand(resetHardCmd, async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Open a folder or workspace first to run git reset.');
      return;
    }
    const cwd = folders[0].uri.fsPath;

    const choice = await vscode.window.showWarningMessage(
      'This will run `git reset --hard` and discard ALL local changes. Are you sure?',
      'Yes, reset hard',
      'Cancel'
    );
    if (choice !== 'Yes, reset hard') return;

    const terminal = createTerminal(cwd, 'Git Reset (Git Bash)');
    if (!terminal) return;

    terminal.show(true);
    terminal.sendText('git reset --hard', true);
  });

  const applyBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  applyBtn.command = applyCmd;

  const resetHardBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  resetHardBtn.text = '$(discard) Reset (Hard)';
  resetHardBtn.tooltip = 'Run `git reset --hard` (discard ALL changes)';
  resetHardBtn.command = resetHardCmd;

  const updateStatusBar = () => {
    const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
    const autoReset = cfg.get<boolean>('autoResetOnApply', false);
    applyBtn.text = autoReset ? '$(git-commit) Reset & Apply (Clipboard)' : '$(git-commit) Apply (Clipboard)';
    applyBtn.tooltip = autoReset
      ? 'Run `git reset --hard` then `git apply ...` from clipboard (Git Bash on Windows)'
      : 'Run `git apply ...` from clipboard (Git Bash on Windows)';
    if (cfg.get<boolean>('showResetButton', true)) {
      resetHardBtn.show();
    } else {
      resetHardBtn.hide();
    }
  };

  updateStatusBar();
  applyBtn.show();

  const cfgListener = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
    if (
      e.affectsConfiguration('gitApplyFromClipboard.autoResetOnApply') ||
      e.affectsConfiguration('gitApplyFromClipboard.showResetButton')
    ) {
      updateStatusBar();
    }
  });

  context.subscriptions.push(runApply, runHardReset, applyBtn, resetHardBtn, cfgListener);
}

export function deactivate() {}

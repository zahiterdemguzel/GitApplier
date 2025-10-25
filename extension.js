const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function findGitBashPath() {
  const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
  const configured = cfg.get('gitBashPath');

  const candidates = [
    configured,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\git-bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  ].filter(Boolean);

  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

/**
 * Strip code fences, leading labels like "Command1:", and grab the
 * first actual shell-y block that contains either:
 *   - "(cd ... && git apply ..."
 *   - "git apply ..."
 * We keep the full multiline script from that point on (so heredocs survive).
 */
function extractScriptFromClipboard(rawText) {
  if (!rawText) return '';

  // normalize newlines, preserve heredocs
  let txt = rawText.replace(/\r\n/g, '\n').trim();

  // unwrap ```...``` if user copied from chat/docs
  if (/^```/.test(txt)) {
    txt = txt.replace(/^```[^\n]*\n?/, '');
    txt = txt.replace(/```$/, '');
    txt = txt.trim();
  }

  // find first real command block that involves git apply
  // we include everything from that match onward because that will usually
  // include the full heredoc body and EOF lines.
  const match = txt.match(/(\(cd[^\n]*git\s+apply[\s\S]*$|^\s*git\s+apply[\s\S]*$)/m);
  if (match) {
    txt = match[1].trim();
  }

  return txt;
}

/**
 * Build an aggressive "force" version of the script.
 *
 * Goal:
 *   - remove "--3way" and other flags we don't care about
 *   - replace "git apply ..." with:
 *       git apply --reject --whitespace=nowarn <rest-of-command> || true
 *
 * We try to preserve heredoc bindings (the "<<'EOF'" part etc.)
 * so multi-line patches still stream in.
 */
function buildForceScript(originalScript) {
  const lines = originalScript.split('\n');
  const forceLines = [];

  for (let line of lines) {
    if (line.match(/\bgit\s+apply\b/)) {
      // Split on first occurrence of "git apply"
      const parts = line.split(/git\s+apply\b/);
      const before = parts[0] || '';
      const after = parts.slice(1).join('git apply'); // (in case 'git apply' appears twice on the same line; super rare)

      // We want to keep any heredoc redirection ("<<'EOF'") or trailing args
      // but drop original flags like --3way etc.
      // Strategy: find the first heredoc marker "<<". Everything from there on we keep.
      // If there's no heredoc, keep everything after the first non-flag token too,
      // but simplest fallback: just keep entire tail.
      let tail = after.trim();

      // Drop leading flags like --3way, --whitespace, etc. up until we hit either
      // a heredoc ("<<") or the end. We'll do a light parse:
      //   e.g. "--3way --someflag <<'EOF'" -> "<<'EOF'"
      //   e.g. "--3way some.patch" -> "some.patch"
      // We'll try to peel known flags from the start of tail.
      const tokens = tail.split(/\s+/);
      let keptTokens = [];
      let foundHeredocStart = false;

      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];

        if (t.startsWith('<<')) {
          // heredoc start: keep from here onward exactly as-is
          keptTokens.push(tokens.slice(i).join(' '));
          foundHeredocStart = true;
          break;
        }

        // discard known flags like --3way / --cached / etc; we want to overwrite, not merge
        if (/^--/.test(t)) {
          // skip this token
          continue;
        }

        // not a flag. This might be a filename patch or path.
        keptTokens.push(t);
      }

      if (!foundHeredocStart) {
        // if we never hit heredoc, rebuild from keptTokens
        tail = keptTokens.join(' ');
      } else {
        // if we hit heredoc, we already pushed the slice(i).join(' ') into keptTokens,
        // so tail should be that joined chunk
        tail = keptTokens.join(' ');
      }

      // Build forced line
      // We ALWAYS add --reject --whitespace=nowarn, which tells git:
      //   - apply what you can straight to the working tree
      //   - anything that can't apply cleanly becomes a *.rej file, but we don't abort
      // then '|| true' so the script never stops on nonzero
      const forced = `${before}git apply --reject --whitespace=nowarn ${tail} || true`;

      forceLines.push(forced);
    } else {
      forceLines.push(line);
    }
  }

  return forceLines.join('\n');
}

/**
 * Spawn bash and feed the provided script via stdin.
 * We don't trim/reshape the script here — caller already built it.
 */
function runShellCommand(commandScript, cwd) {
  return new Promise((resolve, reject) => {
    let shellPath = process.env.SHELL || '/bin/bash';
    const args = [];

    if (os.platform() === 'win32') {
      const bashPath = findGitBashPath();
      if (!bashPath) {
        vscode.window.showErrorMessage(
          'Git Bash not found. Set "Git Apply From Clipboard › Git Bash Path" to your bash.exe (e.g., C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe).'
        );
        reject(new Error('Git Bash not found'));
        return;
      }
      shellPath = bashPath;
      args.push('-s'); // read script from stdin
    } else {
      args.push('-s'); // /bin/bash -s
    }

    const child = spawn(shellPath, args, { cwd });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => {
      stdout += d.toString();
    });
    child.stderr.on('data', d => {
      stderr += d.toString();
    });

    child.on('error', err => {
      reject(err);
    });

    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
      }
    });

    child.stdin.end(commandScript + '\n');
  });
}

/**
 * Reset the repo root hard, using the repo's actual top-level dir,
 * not just the workspace folder.
 */
async function runRepoRootHardReset(cwd) {
  const script = `(cd "$(git rev-parse --show-toplevel)" && git reset --hard)`;
  return runShellCommand(script, cwd);
}

function activate(context) {
  const applyCmd = 'gitApplyFromClipboard.run';
  const resetHardCmd = 'gitApplyFromClipboard.resetHard';

  const runApply = vscode.commands.registerCommand(applyCmd, async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Open a folder or workspace first to run git apply.');
      return;
    }
    const cwd = folders[0].uri.fsPath;

    // read full clipboard
    const rawClipboard = await vscode.env.clipboard.readText();
    const clipScript = extractScriptFromClipboard(rawClipboard);

    if (!clipScript) {
      vscode.window.showWarningMessage('Clipboard is empty or did not contain a runnable script.');
      return;
    }

    const containsGitApply = /\bgit\s+apply\b/i.test(clipScript);
    if (!containsGitApply) {
      const choice = await vscode.window.showWarningMessage(
        'Clipboard does not contain a "git apply" command.',
        'Run anyway',
        'Cancel'
      );
      if (choice !== 'Run anyway') return;
    }

    const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
    const autoReset = cfg.get('autoResetOnApply', false);
    const forceOverwrite = cfg.get('forceOverwriteOnConflict', true);

    try {
      if (autoReset) {
        await runRepoRootHardReset(cwd);
      }

      // First attempt: run script exactly as provided
      try {
        await runShellCommand(clipScript, cwd);
        vscode.window.showInformationMessage('Git apply completed.');
        return;
      } catch (firstErr) {
        // Merge conflict / exit 1 / patch didn’t cleanly apply
        if (!forceOverwrite) {
          throw firstErr;
        }

        // Try forced fallback
        const forcedScript = buildForceScript(clipScript);
        try {
          await runShellCommand(forcedScript, cwd);
          vscode.window.showInformationMessage(
            'Git apply completed with force-overwrite mode (conflicts were ignored / *.rej may exist).'
          );
          return;
        } catch (secondErr) {
          throw secondErr;
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Git apply failed: ${err.message}`);
    }
  });

  const runHardReset = vscode.commands.registerCommand(resetHardCmd, async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Open a folder or workspace first to run git reset.');
      return;
    }
    const cwd = folders[0].uri.fsPath;

    try {
      await runRepoRootHardReset(cwd);
      vscode.window.showInformationMessage('Git reset --hard completed.');
    } catch (err) {
      vscode.window.showErrorMessage(`Git reset --hard failed: ${err.message}`);
    }
  });

  // Status bar UI
  const applyBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  applyBtn.command = applyCmd;

  const resetHardBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  resetHardBtn.text = '$(discard) Reset (Hard)';
  resetHardBtn.tooltip = 'Run `git reset --hard` on repo root (discard ALL changes)';
  resetHardBtn.command = resetHardCmd;

  const updateStatusBar = () => {
    const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
    const autoReset = cfg.get('autoResetOnApply', false);
    const forceOverwrite = cfg.get('forceOverwriteOnConflict', true);

    applyBtn.text = autoReset
      ? '$(git-commit) Reset & Apply (Clipboard)'
      : '$(git-commit) Apply (Clipboard)';

    const forceNote = forceOverwrite
      ? 'Force overwrite on conflict is ENABLED.'
      : 'Force overwrite on conflict is DISABLED.';

    applyBtn.tooltip = autoReset
      ? 'Reset repo to HEAD, then run clipboard patch.\n' + forceNote
      : 'Run clipboard patch.\n' + forceNote;

    if (cfg.get('showResetButton', true)) {
      resetHardBtn.show();
    } else {
      resetHardBtn.hide();
    }
  };

  updateStatusBar();
  applyBtn.show();

  const cfgListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (
      e.affectsConfiguration('gitApplyFromClipboard.autoResetOnApply') ||
      e.affectsConfiguration('gitApplyFromClipboard.showResetButton') ||
      e.affectsConfiguration('gitApplyFromClipboard.forceOverwriteOnConflict')
    ) {
      updateStatusBar();
    }
  });

  context.subscriptions.push(
    runApply,
    runHardReset,
    applyBtn,
    resetHardBtn,
    cfgListener
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};

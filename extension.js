const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const path = require('path');
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
 * Strip code fences, leading labels like "Command1:",
 * and grab the shell block starting at the first command that includes `git apply`.
 * Keep everything from there onward so heredocs survive.
 */
function extractScriptFromClipboard(rawText) {
  if (!rawText) return '';

  let txt = rawText.replace(/\r\n/g, '\n').trim();

  // unwrap ```...``` blocks if copied from chat/docs
  if (/^```/.test(txt)) {
    txt = txt.replace(/^```[^\n]*\n?/, '');
    txt = txt.replace(/```$/, '');
    txt = txt.trim();
  }

  const match = txt.match(/(\(cd[^\n]*git\s+apply[\s\S]*$|^\s*git\s+apply[\s\S]*$)/m);
  if (match) {
    txt = match[1].trim();
  }

  return txt;
}

/**
 * Run a bash script (stdin -> bash -s) in `cwd`.
 * The script can have heredocs and subshells.
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
      args.push('-s');
    } else {
      args.push('-s');
    }

    const child = spawn(shellPath, args, { cwd });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

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
 * Hard reset the repo root (not just the workspace folder).
 */
async function runRepoRootHardReset(cwd) {
  const script = `(cd "$(git rev-parse --show-toplevel)" && git reset --hard)`;
  return runShellCommand(script, cwd);
}

/**
 * --- FORCE OVERWRITE MODE ---
 *
 * If git apply fails, we:
 * - extract the diff text from the heredoc(s) in the script
 * - parse each file's hunks
 * - directly rewrite files on disk using hunk indices (ignoring context match).
 *
 * No .rej files. We just stomp the working tree.
 *
 * Top-level helper:
 *   forceOverwriteFromScript(clipScript, cwd)
 */

/**
 * Pull raw unified diff bodies from the captured script.
 * We support commands like:
 *   (cd ... && git apply --3way <<'EOF'
 *    diff --git a/... b/...
 *    ...
 *    EOF
 *   )
 *
 * There might be multiple heredocs in one clipboard (Command1, Command2).
 * Returns an array of diff text blocks.
 */
function extractDiffBlocksFromScript(scriptText) {
  const blocks = [];
  const heredocRegex = /<<['"]?EOF['"]?\s*\n([\s\S]*?)\nEOF/g;
  let m;
  while ((m = heredocRegex.exec(scriptText)) !== null) {
    blocks.push(m[1]);
  }

  // fallback: if we didn't match any heredoc, maybe the user copied just the diff
  if (blocks.length === 0 && scriptText.includes('diff --git')) {
    blocks.push(scriptText);
  }

  return blocks;
}

/**
 * Parse a unified diff block ("diff --git a/foo b/foo ...") into a per-file structure:
 * {
 *   "path/to/file.py": [
 *      { startOld, countOld, startNew, countNew, newLines: [ 'actual line text', ... ] },
 *      ...
 *   ],
 *   ...
 * }
 *
 * For each hunk:
 *   @@ -a,b +c,d @@
 *   ' ' lines => keep in final
 *   '+' lines => keep in final
 *   '-' lines => removed
 *
 * We'll later apply these hunks by line numbers against the current file.
 */
function parseDiffToFileHunks(diffText) {
  const fileHunks = {};

  // split into file sections by "diff --git a/... b/..."
  const fileSections = diffText.split(/\ndiff --git /);
  for (let i = 0; i < fileSections.length; i++) {
    let section = fileSections[i];
    if (!section.trim()) continue;

    // if we split, the first chunk might not start with "diff --git", re-add it except for first
    if (i > 0) section = 'diff --git ' + section;

    // get the file path from +++ line (the "b/..." side is what we want to write)
    // We'll support standard git diff header:
    // diff --git a/foo b/foo
    // index ...
    // --- a/foo
    // +++ b/foo
    const headerMatch = section.match(/^\s*diff --git a\/(.+?) b\/(.+?)\n/);
    if (!headerMatch) continue;
    const bPath = headerMatch[2].trim();

    // prepare storage
    if (!fileHunks[bPath]) {
      fileHunks[bPath] = [];
    }

    // Now find all hunks in this section
    // @@ -oldStart,oldLen +newStart,newLen @@
    const hunkRegex = /@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@([\s\S]*?)(?=(\n@@|\n(?:diff --git|$)))/g;
    let h;
    while ((h = hunkRegex.exec(section)) !== null) {
      const startOld = parseInt(h[1], 10);
      const countOld = h[2] ? parseInt(h[2], 10) : 1;
      const startNew = parseInt(h[3], 10);
      const countNew = h[4] ? parseInt(h[4], 10) : 1;

      // h[5] is the hunk body up until the next hunk or diff
      const hunkBody = h[5] || '';

      const newLines = [];
      const bodyLines = hunkBody.replace(/^\n/, '').split('\n');
      for (const rawLine of bodyLines) {
        if (!rawLine.length) continue; // skip blank between hunks
        // diff lines:
        //  ' ' context (keep)
        //  '+' added (keep)
        //  '-' removed (drop)
        //  '\' "No newline at end of file" (ignore)
        const firstChar = rawLine[0];
        if (firstChar === ' ') {
          newLines.push(rawLine.slice(1));
        } else if (firstChar === '+') {
          newLines.push(rawLine.slice(1));
        } else if (firstChar === '-') {
          // don't include removed lines
        } else if (rawLine.startsWith('\\ No newline at end of file')) {
          // ignore metadata
        } else {
          // Unexpected prefix; safest is keep literal line?
          // We'll keep it, because maybe patch generator didn't prefix.
          newLines.push(rawLine);
        }
      }

      fileHunks[bPath].push({
        startOld,
        countOld,
        startNew,
        countNew,
        newLines
      });
    }
  }

  return fileHunks;
}

/**
 * Apply hunks destructively to a file on disk.
 * We DO NOT try to match context.
 * We just trust the hunk indices from the diff.
 *
 * Logic per hunk (bottom-up to keep indexes stable):
 *   - Remove `countOld` lines starting at `startOld - 1`
 *   - Insert `newLines`
 *
 * If file doesn't exist, we "synthesize" by concatenating all newLines
 * from all hunks in order (best effort).
 */
function applyHunksToFileAbs(pathOnDisk, hunks) {
  // read file if exists, else start with empty
  let fileLines = [];
  let fileExists = true;
  try {
    const content = fs.readFileSync(pathOnDisk, 'utf8');
    fileLines = content.split('\n');
  } catch (e) {
    fileExists = false;
    fileLines = [];
  }

  if (!fileExists) {
    // naive synthesis: if file doesn't exist yet, just stitch all newLines
    // from hunks in ascending startNew order. This is usually fine for brand new files.
    const synthetic = [];
    const sortedHunksNew = [...hunks].sort((a, b) => a.startNew - b.startNew);
    for (const h of sortedHunksNew) {
      for (const ln of h.newLines) {
        synthetic.push(ln);
      }
    }
    fs.mkdirSync(path.dirname(pathOnDisk), { recursive: true });
    fs.writeFileSync(pathOnDisk, synthetic.join('\n'), 'utf8');
    return;
  }

  // For existing files:
  // sort hunks by startOld DESC so splices don't shift earlier hunks
  const sortedHunksOld = [...hunks].sort((a, b) => b.startOld - a.startOld);

  for (const h of sortedHunksOld) {
    const removeStart = Math.max(h.startOld - 1, 0);
    const removeCount = h.countOld || 0;
    const replacement = h.newLines;

    // Ensure array is long enough (pad with empty lines if crazy indices)
    while (fileLines.length < removeStart) {
      fileLines.push('');
    }

    fileLines.splice(removeStart, removeCount, ...replacement);
  }

  fs.mkdirSync(path.dirname(pathOnDisk), { recursive: true });
  fs.writeFileSync(pathOnDisk, fileLines.join('\n'), 'utf8');
}

/**
 * High-level fallback:
 * 1. pull unified diff text from clipboard script
 * 2. parse file hunks
 * 3. write changes directly to disk
 */
function forceOverwriteFromScript(clipScript, cwd) {
  const diffBlocks = extractDiffBlocksFromScript(clipScript);
  if (diffBlocks.length === 0) {
    throw new Error('No diff blocks found in clipboard script for force overwrite.');
  }

  for (const diffText of diffBlocks) {
    const fileHunksMap = parseDiffToFileHunks(diffText);

    for (const relPath in fileHunksMap) {
      const hunks = fileHunksMap[relPath];
      const absPath = path.join(cwd, relPath.replace(/^b\//, '').replace(/^a\//, '')); // prefer b/ side

      applyHunksToFileAbs(absPath, hunks);
    }
  }
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

      // 1. First attempt: run their script normally (git apply --3way ...)
      try {
        await runShellCommand(clipScript, cwd);
        vscode.window.showInformationMessage('Git apply completed.');
        return;
      } catch (firstErr) {
        // That failed. We'll fall back if allowed.
        if (!forceOverwrite) {
          throw firstErr;
        }
      }

      // 2. Force-overwrite fallback
      try {
        forceOverwriteFromScript(clipScript, cwd);
        vscode.window.showInformationMessage(
          'Force overwrite completed (files were directly rewritten, no .rej).'
        );
        return;
      } catch (forceErr) {
        throw forceErr;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Git apply / overwrite failed: ${err.message}`);
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

  // status bar UI
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
      ? 'Force overwrite on conflict is ENABLED (will rewrite files).'
      : 'Force overwrite on conflict is DISABLED (will stop on conflict).';

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
      e.affectsConfiguration('gitApplyFromClipboard.forceOverwriteOnConflict') ||
      e.affectsConfiguration('gitApplyFromClipboard.gitBashPath')
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

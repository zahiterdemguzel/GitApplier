"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const os = require("os");
const fs = require("fs");
function exists(p) {
    try {
        return fs.existsSync(p);
    }
    catch (_a) {
        return false;
    }
}
function findGitBashPath() {
    const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
    const configured = cfg.get('gitBashPath');
    const candidates = [
        configured,
        'C:\\\Program Files\\Git\\bin\\bash.exe',
        'C:\\\Program Files\\Git\\git-bash.exe',
        'C:\\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\\Program Files (x86)\\Git\\bin\\bash.exe'
    ].filter(Boolean);
    for (const c of candidates) {
        if (exists(c))
            return c;
    }
    return null;
}
function createTerminal(cwd, name) {
    if (os.platform() === 'win32') {
        const bashPath = findGitBashPath();
        if (!bashPath) {
            vscode.window.showErrorMessage('Git Bash not found. Set "Git Apply From Clipboard › Git Bash Path" to your bash.exe (e.g., C:\\Program Files\\Git\\bin\\bash.exe).');
            return null;
        }
        return vscode.window.createTerminal({
            name,
            cwd,
            shellPath: bashPath,
            shellArgs: ['--login', '-i']
        });
    }
    else {
        return vscode.window.createTerminal({ name, cwd });
    }
}
function activate(context) {
    const applyCmd = 'gitApplyFromClipboard.run';
    // Command identifier for performing a hard reset on the current repo
    const resetHardCmd = 'gitApplyFromClipboard.resetHard';
    const runApply = vscode.commands.registerCommand(applyCmd, () => __awaiter(this, void 0, void 0, function* () {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage('Open a folder or workspace first to run git apply.');
            return;
        }
        const cwd = folders[0].uri.fsPath;
        const clip = (yield vscode.env.clipboard.readText()).trim();
        if (!clip) {
            vscode.window.showWarningMessage('Clipboard is empty.');
            return;
        }
        const containsGitApply = /\bgit\s+apply\b/i.test(clip);
        if (!containsGitApply) {
            const choice = yield vscode.window.showWarningMessage('Clipboard does not contain a "git apply" command.', 'Run anyway', 'Cancel');
            if (choice !== 'Run anyway')
                return;
        }
        const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
        const autoReset = cfg.get('autoResetOnApply', false);
        const terminal = createTerminal(cwd, 'Git Apply (Git Bash)');
        if (!terminal)
            return;
        terminal.show(true);
        if (autoReset) {
            terminal.sendText('git reset --hard', true);
        }
        terminal.sendText(clip, false);
        terminal.sendText('', true);
    }));
    // Execute `git reset --hard` immediately with no confirmation
    const runHardReset = vscode.commands.registerCommand(resetHardCmd, () => __awaiter(this, void 0, void 0, function* () {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage('Open a folder or workspace first to run git reset.');
            return;
        }
        const cwd = folders[0].uri.fsPath;
        const terminal = createTerminal(cwd, 'Git Reset (Git Bash)');
        if (!terminal)
            return;
        terminal.show(true);
        terminal.sendText('git reset --hard', true);
    }));
    const applyBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    applyBtn.command = applyCmd;
    const resetHardBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    resetHardBtn.text = '$(discard) Reset (Hard)';
    resetHardBtn.tooltip = 'Run `git reset --hard` (discard ALL changes)';
    resetHardBtn.command = resetHardCmd;
    const updateStatusBar = () => {
        const cfg = vscode.workspace.getConfiguration('gitApplyFromClipboard');
        const autoReset = cfg.get('autoResetOnApply', false);
        applyBtn.text = autoReset ? '$(git-commit) Reset & Apply (Clipboard)' : '$(git-commit) Apply (Clipboard)';
        applyBtn.tooltip = autoReset
            ? 'Run `git reset --hard` then `git apply ...` from clipboard (Git Bash on Windows)'
            : 'Run `git apply ...` from clipboard (Git Bash on Windows)';
        if (cfg.get('showResetButton', true)) {
            resetHardBtn.show();
        }
        else {
            resetHardBtn.hide();
        }
    };
    updateStatusBar();
    applyBtn.show();
    const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitApplyFromClipboard.autoResetOnApply') ||
            e.affectsConfiguration('gitApplyFromClipboard.showResetButton')) {
            updateStatusBar();
        }
    });
    context.subscriptions.push(runApply, runHardReset, applyBtn, resetHardBtn, cfgListener);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map
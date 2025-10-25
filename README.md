# Git Apply From Clipboard

This extension adds status bar buttons to run `git apply ...` or `patch ...` commands from your clipboard or perform a `git reset --hard`.
Commands are executed directly using your system shell, and a notification is shown when they complete.

**Warning:** The **Reset (Hard)** button runs `git reset --hard` immediately without confirmation and discards all local changes.

## Windows Users
- It will **force Git Bash**, so heredoc commands like `<<'EOF'` work.
- If Git is installed in a non-standard location, configure the setting:
  **Settings → Extensions → Git Apply From Clipboard → Git Bash Path**

## Usage
1. Copy your `git apply` or `patch` command (can be multi-line, subshell, heredoc, etc.).
2. Open your repo folder in VS Code.
3. Click **Apply (Clipboard)** to run your command or **Reset (Hard)** to discard all local changes.


# Git Apply From Clipboard

This extension adds status bar buttons to run `git apply ...` from your clipboard or perform a `git reset --hard`.

**Warning:** The **Reset (Hard)** button runs `git reset --hard` immediately without confirmation and discards all local changes.

## Windows Users
- It will **force Git Bash**, so heredoc commands like `<<'EOF'` work.
- If Git is installed in a non-standard location, configure the setting:
  **Settings → Extensions → Git Apply From Clipboard → Git Bash Path**

## Usage
1. Copy your `git apply` command (can be multi-line, subshell, heredoc, etc.).
2. Open your repo folder in VS Code.
3. Click **Apply (Clipboard)** to run your patch or **Reset (Hard)** to discard all local changes.


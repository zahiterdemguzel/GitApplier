# Git Apply From Clipboard

This extension adds a status bar button that runs the `git apply ...` command from your clipboard.

## Windows Users
- It will **force Git Bash**, so heredoc commands like `<<'EOF'` work.
- If Git is installed in a non-standard location, configure the setting:
  **Settings → Extensions → Git Apply From Clipboard → Git Bash Path**

## Usage
1. Copy your `git apply` command (can be multi-line, subshell, heredoc, etc.).
2. Open your repo folder in VS Code.
3. Click **Apply (Clipboard)** in the status bar, or run **Git: Apply from Clipboard**.


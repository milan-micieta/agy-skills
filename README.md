# agy-skills

Native Antigravity side-pane plugin for browsing, toggling, security-previewing, and installing agent skills.

## Features

- **Installed Skills**: Lists global, project, plugin, and builtin skills with token counts, 60-day usage telemetry (`skill-usage.jsonl`), and one-click enable/disable toggling.
- **Discover (`skillsdirectory.com`)**: Fetches verified **Grade A** skills from [skillsdirectory.com](https://www.skillsdirectory.com/) sorted by GitHub stars, with live search.
- **Security Preview & Install**: Fetches `SKILL.md` from GitHub, scans for risky shell patterns or sensitive file references, and installs into global (`~/.gemini/config/skills`) or project (`.agents/skills`) scope.

## Installation

Copy or link this plugin directory into `~/.gemini/config/plugins/agy-skills` and enable it in the Antigravity Plugins Manager.

## Structure

- `plugin.json` — Plugin manifest
- `skills/skills/SKILL.md` — `/skills` slash-command / skill entrypoint
- `sidecars/skills_panel/` — Node.js `SidecarApp` backend & webview UI

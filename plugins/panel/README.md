# panel

A pane beside the chat that shows what this session is doing.

![panel](../../docs/panel.png)

| Section | Shows |
| --- | --- |
| Session | Directory, git branch, model and effort, context, 5-hour and weekly usage with reset times |
| Agents | Main thread and every subagent: state, duration, output tokens, model, effort |
| GitHub | PRs / issues you pasted or `gh` touched, with live status; tabs for PR, Issue, Others |
| Links | Links you pasted or a tool published (Artifacts, MCP results, dev servers), tabbed by site |

Hover a row for copy and ×. Section titles fold.

## Install

```sh
claude plugin marketplace add itaober/agent-plugins
claude plugin install panel@itaober
```

## Commands

| Command | Does |
| --- | --- |
| `/panel` | Open or close the pane (remembered across sessions) |
| `/panel demo` | Toggle fictional demo data, for screenshots |

## Options

Set in `/config`. Invalid values fall back to the default.

| Option | Default | Meaning |
| --- | --- | --- |
| `showSession` `showAgents` `showGit` `showLinks` | `true` | Show each section (GitHub off = `gh` never runs) |
| `width` | `46` | Pane width in columns |
| `autoOpen` | `true` | Open the pane when a session starts |
| `visibleRows` | `6` | Rows per section or tab before "+N more" |
| `tabThreshold` | `3` | Links from one site needed for its own Links tab |
| `ghRefreshSeconds` | `60` | How often open PRs / issues are rechecked; `0` = once |
| `agentsKeep` | `10` | Minutes a finished agent keeps its row before folding into the summary; `0` = never fold |
| `gitSort` | `attention` | PR / issue order: `attention` (needs action first), `recent`, `repo` |
| `sessionLines` | `dir,model,context,5h,week` | Session lines to show, in order |
| `sessionBars` | `true` | Bars before percentages |
| `sessionTheme` | `gruvbox` | Colors: `gruvbox`, `hud` (matches claude-hud), `terminal` |

## Limitations

- Terminal only; the pane docks when the terminal is at least 144 columns wide.
- PR / issue status needs the `gh` CLI, logged in.
- Icons are Nerd Font Octicons: use a Nerd Font, or Ghostty (built in).
- Pressing an agent opens `/tasks`; the plugin API cannot jump to an agent's transcript.
- Token counts reset when Claude Code restarts.

## Develop

```sh
claude --plugin-dir plugins/panel     # load from disk, reloads on save
claude plugin validate plugins/panel
claude plugin test plugins/panel
```

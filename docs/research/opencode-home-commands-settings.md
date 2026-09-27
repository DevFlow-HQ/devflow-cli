# OpenCode Home Screen Commands, Themes, and Settings

Research date: 2026-09-27

Upstream source snapshot: OpenCode commit
[`228e9095ba3988a02664c3816cb51f98584e86c2`](https://github.com/anomalyco/opencode/tree/228e9095ba3988a02664c3816cb51f98584e86c2)
(`dev`, committed 2026-09-14)

Ticket: [#237](https://github.com/secantdev/secant/issues/237)

## Answer

OpenCode's home screen has no menu. It shows a logo above one multi-line prompt. That prompt starts a Session and also leads to everything else.
Typing a message and pressing Enter creates a Session and switches to it. A `/` at the start of the input opens an inline list of slash commands, and
`ctrl+p` opens a full command palette.[^oc-home][^oc-prompt-submit][^oc-prompt-hints]

Both surfaces read one command catalog held by `@opentui/keymap`. Each command is registered in the `palette` namespace with a name, title, category,
and an optional `slashName` and `slashAliases`. Key bindings attach separately, from defaults that `tui.json` can override.[^oc-app-commands][^oc-keybinds]
The `/` list shows two kinds of entry. The first is every reachable, visible command that has a slash name. The second is every prompt command the
server provides: `/init`, `/review`, user commands, and MCP prompts. The list is fuzzy-filtered to at most 10 rows. Choosing a client command runs it at
once. Choosing a server command writes `/name ` into the prompt so the user can type arguments before pressing Enter.[^oc-slashes][^oc-ac-list][^oc-ac-filter][^oc-ac-select]

Themes are chosen with `/themes` or `<leader>t`, where the leader is `ctrl+x`. This opens a searchable list of every registered theme name: 33
built-ins, plugin themes, JSON files in `themes/` directories, and a generated `system` theme when the terminal palette can be read. Moving the cursor or
typing a filter applies a theme to the whole UI at once. Enter keeps it, and Esc restores the theme that was active when the list opened. Dark or light
mode is a separate palette command and can be locked.[^oc-theme-dialog][^oc-theme-registry][^oc-theme-context]

The other settings a user can change from the TUI are palette toggles: animations, file context, diff wrapping, paste summary, session directory
filtering, the terminal title, home tips, auto-approve permissions, and plugins. There are also pickers for model, variant, agent, and MCP servers, and
display toggles inside the Session view. Key bindings, prompt size, scrolling, cursor, mouse, and sounds cannot be changed from the TUI; they live only
in `tui.json`.[^oc-app-commands][^oc-tui-schema]

Toggled preferences persist in one JSON key-value file, `kv.json`, in OpenCode's state directory. That directory is `$XDG_STATE_HOME/opencode`, or else
`~/.local/state/opencode`. The path has the same XDG shape on Linux, macOS, and Windows, because the `xdg-basedir` package OpenCode uses has no
per-platform branch. Recent models, favourites, and variants go to `model.json` in the same directory.[^oc-kv][^oc-global][^xdg][^oc-local-model]

Hand-written settings live in `tui.json`: a global file at `~/.config/opencode/tui.json`, plus project and `.opencode` layers. The TUI writes that file
only when it installs a plugin. At startup the CLI loads `tui.json` before rendering, and the KV file is read before any screen mounts.[^oc-tui-config][^oc-plugin-state][^oc-cli-tui][^oc-helper]
The theme then resolves as the `tui.json` `theme`, else the KV `theme`, else `opencode`. So a theme named in `tui.json` replaces the picker's choice on
every launch.[^oc-theme-context]

For contrast, Secant's home screen today is a four-entry arrow-key menu. It has no text input, no command list, and no settings. Its theme provider
always resolves `nord` in dark mode, with no picker and nothing persisted.[^sec-home][^sec-theme-context]

## Evidence Boundary

- **Source-observed**: read in the local OpenCode clone at `228e909` (the TUI package `packages/tui`, the CLI host `packages/opencode`, and the path
  module `packages/core`), in Secant at `9388dec`, or in a published npm package named below.
- **Documented**: stated in OpenCode's first-party docs, which live in the same tree under `packages/web/src/content/docs`.
- **Inferred**: a conclusion drawn from source-observed or documented facts. These are marked where they appear.
- Secant's vendored copy is pinned to OpenCode `1ead9e3d7f`. Between that commit and `228e909`, the files studied here differ only in three `...` to
  `…` string edits in `app.tsx` and `component/prompt/index.tsx`. The findings therefore also describe Secant's pin.
- `@opentui/keymap` facts come from the published `0.4.5` package, the version both OpenCode and Secant pin.[^sec-package] Path facts come from the
  published `xdg-basedir@5.1.0`, the version `packages/core` pins.[^xdg]
- OpenCode was not run. The per-platform paths are derived from source and were not observed on macOS or Windows.

## The Home Screen and Its Prompt

**Layout.** `Home` stacks the following, centred vertically:[^oc-home][^oc-builtins][^oc-footer][^oc-tips]

- a `home_logo` plugin slot, which shows the logo;
- a `home_prompt` slot holding the `Prompt`. Its width is capped at 75 columns, or at `tui.json` `prompt.max_width`, where `"auto"` means the larger of
  75 and 70% of the terminal width;
- a `home_bottom` slot. The built-in tips plugin fills it;
- a toast area;
- a `home_footer` slot. The built-in footer fills it with the directory and git branch, a connected-MCP count followed by a `/status` hint, and the
  version.

**Tips.** The tips show unless the user hid them. They also stay hidden on a first run when a provider is already connected. The tip text advertises
commands, for example "Use /themes to switch between 33 built-in themes" and "Place TUI settings in ~/.config/opencode/tui.json".[^oc-tips][^oc-tips-view]

**The prompt.**

- The placeholder is `Ask anything… "<example>"`, with the example chosen at random.[^oc-home][^oc-prompt-placeholder]
- Under the text it shows the current agent, `auto` when auto-approve is on, the model, the provider, and the variant.[^oc-prompt-meta]
- The only on-screen pointers to commands are the two hints on the right: `tab agents` and `ctrl+p commands`.[^oc-prompt-hints]
- `!` typed at the very start switches to shell mode, and Esc leaves it.[^oc-prompt-shell]
- `@` opens a list of files, agents, and MCP resources to mention.[^oc-ac-open]
- Up and Down at the edges of the buffer walk through prompt history.[^oc-prompt-history]

**Submitting.** Enter has several guards and outcomes:[^oc-prompt-submit]

- It does nothing while the autocomplete list is open.
- `exit`, `quit`, or `:q` quits the app.
- With no model, it shows a toast and the provider dialog.
- On the home route it creates a Session with the current agent, model, and variant. It then sends a shell command, a server slash command, or a
  prompt, and switches to the Session route after 50 ms.

The `--prompt` CLI argument pre-fills the home prompt once per process and submits it after sync and the model store are ready.[^oc-home] When the
provider list is empty, the app opens the provider dialog by itself, so a first run lands on a connect dialog.[^oc-app-provider-dialog]

## One Command Catalog, Four Ways In

**Registration.** A command is an object handed to `useBindings({ commands })`. Its fields are `name`, `title`, `desc`, `category`, `suggested`,
`hidden`, `enabled`, `slashName`, `slashAliases`, and `run`. Four places register commands:

- the app shell, whose commands are all put in the `palette` namespace;[^oc-app-commands]
- the prompt, which covers the editor, skills, stash, move, and warp commands;[^oc-prompt-commands][^oc-stash-commands]
- the Session route, whose commands exist only while that route is mounted;[^oc-session-commands][^oc-app-route]
- plugins. The built-in diff viewer and plugin manager register their own commands,[^oc-diff][^oc-plugins] and third-party TUI plugins go through a
  shim that also sets the `palette` namespace and the slash fields.[^oc-plugin-shim]

**Reachability.** Command queries default to the keymap's `reachable` view, which draws commands only from layers that are active now.[^keymap-visibility]
A command whose `enabled` is false is made inactive by the `enabled` field addon, which OpenTUI's default keymap registers.[^keymap-enabled] So the set a
user sees depends on route and state:

- Session-only commands are absent on home.
- `/variants` is hidden when the model has no variants.
- `/org` exists only when more than one console org can be switched to.
- `/workspaces` and `/warp` sit behind `OPENCODE_EXPERIMENTAL_WORKSPACES`.[^oc-app-commands][^oc-prompt-commands]

**Key bindings are separate.** `config/keybind.ts` names each binding with its default, for example `leader: ctrl+x`, `command_list: ctrl+p`, and
`theme_list: <leader>t`. A `CommandMap` maps binding names to command ids. Any binding can be overridden in `tui.json` `keybinds`, and `none` or `false`
disables it.[^oc-keybinds] Each component gathers the bindings for its own commands.[^oc-app-bindings]

**The four ways in:**

1. **The `/` list**, described in the next section.
2. **The command palette** (`ctrl+p`). It lists every reachable palette command that is not hidden, including the many with no slash name. Each row shows
   the title and description, grouped by category, with the key binding as a footer. With an empty filter, a "Suggested" group comes first.[^oc-palette]
   The suggested commands are:[^oc-app-commands]
   - Switch model, always;
   - Switch session, when sessions exist;
   - Connect provider, when no provider is connected;
   - Switch org, when an org is active;
   - New session, on the Session route.

   The filter fuzzy-matches title and category, with the title weighted double.[^oc-dialog-select]

3. **A direct key binding**, dispatched by the keymap.
4. **A `tui.command.execute` event**, which the server or a plugin can send to dispatch any command by name.[^oc-app-exit-binding]

## Typing `/`: How the List Opens, Filters, and Runs

**Opening.** Every content change calls the autocomplete's `onInput`.[^oc-prompt-textarea] The `/` list opens when two things hold: the input starts
with `/`, and there is no whitespace between the start and the cursor. It closes in three cases: the cursor moves before the `/`, whitespace appears
after it, or the input becomes `/<command> <argument>`. While the list is open, the keymap is in an `autocomplete` mode.[^oc-ac-open]

**Contents.** The list has two sources:

- **Client commands.** `useCommandSlashes()` takes every reachable `palette` command that has a `slashName`, is not hidden, and is not the palette
  command itself. It shows each as `/name` with its `desc` (or its title), and turns the aliases into `/alias`.[^oc-slashes]
- **Server commands** from `sync.data.command`. Skill entries are skipped (skills are reached through `/skills` instead), and MCP prompts get a `:mcp`
  suffix. The rows are sorted by name and padded so that the descriptions line up.[^oc-ac-list] The server builds this list itself. It holds the
  built-ins `init` ("guided AGENTS.md setup") and `review`, the `command` entries in config, markdown files under `command/` or `commands/`, MCP prompts,
  and skills.[^oc-server-commands][^oc-command-dir]

**Filtering.** The query is the text after `/` up to the cursor. An empty query shows every entry. Otherwise the query is fuzzy-matched against the
name, the description, and the aliases, with no score threshold and a limit of 10. A match at the start of the name scores double.[^oc-ac-filter] The
popup is at most 10 rows high and fits above the prompt. It shows "No matching items" when nothing matches, and each filter change moves the selection
back to the top.[^oc-ac-render]

**Keys.** Up or `ctrl+p` moves up, Down or `ctrl+n` moves down, Esc hides the list, Enter selects, and Tab completes. The mouse can hover and click.[^oc-keybinds][^oc-ac-keys]

**Running.** Selecting first hides the list. If the input is a bare `/name` with no trailing space, hiding also deletes that text.[^oc-ac-select] What
happens next depends on the entry:

- A client entry then calls `keymap.dispatchCommand(name)`. For example, `/themes` opens the theme dialog.[^oc-slashes]
- A server entry replaces the text with `/name ` and leaves the cursor there for arguments. Enter then sends `session.command` with the first-line
  arguments and any following lines. On home, a Session is created first.[^oc-ac-list][^oc-prompt-submit]

The submit path recognises only server command names. A client command runs through the list, its key binding, or the palette.[^oc-prompt-submit]

## The Commands That Exist

**Slash commands reachable on the home screen.** This covers the built-in client commands only. Third-party plugins can add more.

| Slash (aliases)                      | Palette title (category)      | Default key                                    | Does                                     | Shown when                   |
| ------------------------------------ | ----------------------------- | ---------------------------------------------- | ---------------------------------------- | ---------------------------- |
| `/sessions` (`/resume`, `/continue`) | Switch session (Session)      | `<leader>l`                                    | Opens the session list                   | Always                       |
| `/new` (`/clear`)                    | New session (Session)         | `<leader>n`                                    | Returns to home                          | Always                       |
| `/models` (`/mo`)                    | Switch model (Agent)          | `<leader>m`                                    | Opens the model picker                   | Always                       |
| `/agents`                            | Switch agent (Agent)          | `<leader>a`                                    | Opens the agent picker                   | Always                       |
| `/variants`                          | Switch model variant (Agent)  | none                                           | Opens the variant picker                 | The model has variants       |
| `/mcps`                              | Toggle MCPs (Agent)           | none                                           | Opens the MCP dialog                     | Always                       |
| `/connect`                           | Connect provider (Provider)   | none                                           | Opens the provider list                  | Always                       |
| `/org` (`/orgs`, `/switch-org`)      | Switch org (Provider)         | none                                           | Opens the console org dialog             | More than one switchable org |
| `/status`                            | View status (System)          | `<leader>s`                                    | Opens the status dialog                  | Always                       |
| `/debug`                             | View debug info (System)      | none                                           | Opens the debug dialog                   | Always                       |
| `/themes`                            | Switch theme (System)         | `<leader>t`                                    | Opens the theme picker                   | Always                       |
| `/help`                              | Help (System)                 | none                                           | Opens help, which points to `ctrl+p`     | Always                       |
| `/exit` (`/quit`, `/q`)              | Exit the app (System)         | `ctrl+c`, `ctrl+d`, `<leader>q` (prompt empty) | Quits                                    | Always                       |
| `/workspaces`                        | Manage workspaces (Workspace) | none                                           | Opens the workspace list                 | Experimental workspaces flag |
| `/editor`                            | Open editor (Session)         | `<leader>e`                                    | Edits the prompt in `$EDITOR`            | Always                       |
| `/skills`                            | Skills (Prompt)               | none                                           | Opens a skill picker, writes `/<skill> ` | Always                       |
| `/move`                              | Move session (Session)        | none                                           | Opens the move-to-directory dialog       | Always                       |
| `/warp`                              | Warp (Session)                | none                                           | Opens the workspace picker               | Experimental workspaces flag |
| `/diff`                              | Open diff viewer (VCS)        | none                                           | Opens the diff viewer route              | Built-in plugin loaded       |

Sources: the app commands, the prompt commands, the diff viewer plugin, and the key binding defaults, with the exit binding active only while the
prompt is empty.[^oc-app-commands][^oc-prompt-commands][^oc-diff][^oc-keybinds][^oc-app-exit-binding]

**Server slash commands.**

- `/init` and `/review`, both built in.
- Every config `command` entry and every `command/` or `commands/` markdown file.
- Every MCP prompt, shown with a `:mcp` suffix.[^oc-server-commands][^oc-command-dir][^oc-ac-list]

**Slash commands that exist only on the Session route.**

- `/share`, `/unshare`, `/rename`, `/timeline`, `/fork`, `/copy`, and `/export`
- `/compact` (`/summarize`)
- `/undo` and `/redo`
- `/timestamps` (`/toggle-timestamps`)
- `/thinking` (`/toggle-thinking`)[^oc-session-commands]

**Palette-only commands reachable on home**, with no slash name:

- theme: Switch to light or dark mode; Lock or unlock theme mode;
- app toggles: Enable or disable terminal title, animations, file context, diff wrapping, paste summary, and session directory filtering; Enable or
  disable auto-approve permissions; Show or hide tips;
- tools: Open docs; Toggle debug panel; Toggle console; Write heap snapshot;
- plugins: Plugins; Install plugin;
- model: Variant cycle (`ctrl+t`);
- prompt: Stash prompt (when the input is not empty); Stash pop and Stash list (when the stash is not empty); Remove editor context (only while an editor
  selection is attached);
- workspace: Copy worktree path (only in a worktree workspace).[^oc-app-commands][^oc-tips][^oc-plugins][^oc-prompt-commands][^oc-stash-commands]

**Commands reachable only by key binding.** These are hidden from both lists:

- prompt submit, clear, and paste; session interrupt;
- cycling through recent models (`f2`, `shift+f2`) and favourite models;
- cycling agents (`tab`, `shift+tab`);
- quick session slots (`<leader>1` to `<leader>9`);
- terminal suspend (`ctrl+z`, not on Windows);
- the which-key overlay toggles, which are registered without the `palette` namespace.[^oc-app-commands][^oc-keybinds][^oc-which-key]

## Themes: Listing, Previewing, and Choosing

**Registry.** OpenCode imports 33 theme JSON assets into `DEFAULT_THEMES`. The live list merges four sources, each overriding the one before:
built-ins, then plugin themes (added with `addTheme`), then custom theme files, then the generated `system` theme.[^oc-theme-registry] A theme file has
`defs` and a `theme` object. Each colour is a hex value, a reference, an ANSI number, or a `{ dark, light }` pair, and is resolved for the current mode.[^oc-theme-resolve]

**Custom theme discovery.** The TUI searches `Global.Path.config`, then `.opencode` in the working directory and in each ancestor up to the root. In
each it globs `themes/*.json`, and the file name becomes the theme name.[^oc-theme-discovery] Later directories overwrite earlier ones in the map, so
the source gives an ancestor's `.opencode/themes` file priority over one of the same name nearer the working directory. The docs describe the opposite
order (see [Documentation Drift](#documentation-drift)). Files whose `theme` is not an object are dropped. Sending the process `SIGUSR2` re-runs
discovery.[^oc-theme-context]

**The `system` theme.** OpenCode asks the terminal for its 16-colour palette and generates a theme from it. If the terminal returns no palette, `system`
is left out, and an active `system` falls back to `opencode`.[^oc-theme-context]

**Listing.** The list holds every registered name, sorted without regard to case. Each row is the name alone, with no category, description, or colour
swatch. The current theme is marked `●`, and the cursor starts on it.[^oc-theme-dialog][^oc-dialog-select]

**Previewing.** Moving the cursor calls `theme.set`. Typing a filter fuzzy-matches the names and previews the first match, and clearing the filter
restores the original theme.[^oc-theme-dialog] The whole UI repaints at once, because components read colours through a reactive proxy and the
renderer background follows the active theme.[^oc-theme-context]

**Choosing and cancelling.** Enter sets the theme, marks it confirmed, and closes the dialog. Esc or `ctrl+c` pops the dialog instead. On close, an
unconfirmed dialog restores the theme that was active when it opened.[^oc-theme-dialog][^oc-dialog]

**The KV side effect.** `theme.set` writes the KV store on every call, so each preview step writes `kv.json`, and a cancel writes the original name
back.[^oc-theme-context]

**Dark and light mode.** Mode is separate from the theme name.[^oc-theme-context][^oc-app-boot]

- At startup the mode is the KV lock if one exists. Otherwise it is the renderer's reported mode, and otherwise the mode detected before rendering. That
  detection waits up to 1 s and falls back to `dark`.
- The mode follows the terminal's mode-change events unless it is locked.
- The palette command "Switch to light mode" (or dark) calls `setMode`, and `setMode` is the same function as the lock. Switching therefore also locks
  the mode and writes `theme_mode_lock`.
- "Lock theme mode" and "Unlock theme mode" set and clear the lock.[^oc-app-commands][^oc-theme-context]
- Both mode commands default to no key binding.[^oc-keybinds]

## Other Settings Changeable From the TUI

| Setting                             | How it is changed                                | Where it is stored                                                                                                                                           | Default                                                             |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Theme                               | `/themes`, `<leader>t`                           | KV `theme`; `tui.json` `theme` overrides it at startup                                                                                                       | `opencode`                                                          |
| Dark or light mode                  | Palette "Switch to light/dark mode", which locks | KV `theme_mode_lock`, `theme_mode`                                                                                                                           | Follows the terminal                                                |
| Animations                          | Palette toggle                                   | KV `animations_enabled`                                                                                                                                      | `true`                                                              |
| File context (editor selection)     | Palette toggle                                   | KV `file_context_enabled`                                                                                                                                    | `true`                                                              |
| Diff wrapping                       | Palette toggle                                   | KV `diff_wrap_mode`                                                                                                                                          | `word`                                                              |
| Paste summary                       | Palette toggle                                   | KV `paste_summary_enabled`                                                                                                                                   | On, unless config `experimental.disable_paste_summary` is set       |
| Session directory filtering         | Palette toggle                                   | KV `session_directory_filter_enabled`                                                                                                                        | `true`                                                              |
| Terminal title                      | Palette toggle                                   | KV `terminal_title_enabled`                                                                                                                                  | `true`                                                              |
| Home tips                           | Palette toggle, `<leader>h`                      | KV `tips_hidden`                                                                                                                                             | Shown                                                               |
| Plugin on or off                    | Palette "Plugins" dialog                         | KV `plugin_enabled`, layered over `tui.json` `plugin_enabled`                                                                                                | From config                                                         |
| Plugin install                      | Palette "Install plugin"                         | Patches the config file (`tui.json` or `opencode.json`)                                                                                                      | None                                                                |
| Which-key layout, pending preview   | Which-key key bindings                           | KV `which_key_layout`, `which_key_pending_preview`                                                                                                           | `dock`, `false`                                                     |
| Model                               | `/models`, `f2` through recent models            | `model.json` `recent`, `favorite`; the first valid recent model wins                                                                                         | `--model`, then config `model`, then recents, then provider default |
| Variant                             | `/variants`, `ctrl+t`                            | `model.json` `variant`                                                                                                                                       | None                                                                |
| Agent                               | `/agents`, `tab`                                 | Memory only                                                                                                                                                  | First primary agent                                                 |
| Auto-approve permissions            | Palette toggle                                   | Memory only                                                                                                                                                  | `--auto` flag, else off                                             |
| MCP servers on or off               | `/mcps`                                          | A live server connect or disconnect, not a TUI preference                                                                                                    | Config                                                              |
| Session view display (Session only) | Session palette, `/timestamps`, `/thinking`      | KV `sidebar`, `timestamps`, `tool_details_visibility`, `scrollbar_visible`, `generic_tool_output_visibility`, `thinking_mode`; code concealment is not saved | Various                                                             |

The table draws on each command's own code, the stores behind it, and the plugin runtime.[^oc-app-commands][^oc-app-signals][^oc-tips][^oc-plugin-state][^oc-which-key][^oc-local-model][^oc-local-agent][^oc-permission][^oc-session-kv]

**Settings only `tui.json` can change.** These are key bindings, `leader_timeout`, `prompt.max_height`, `prompt.max_width`, `scroll_speed`,
`scroll_acceleration`, `diff_style`, `cursor`, `mouse`, `attention` (sounds and notifications), and the plugin list. The TUI never writes them.[^oc-tui-schema]

## Where Preferences Persist, and How They Load

**Files.**

| File                                                           | Directory                                | Holds                                        | Written by                                                               |
| -------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `kv.json`                                                      | State                                    | Every KV key above                           | `kv.set`: a full snapshot, written atomically under a file lock          |
| `model.json`                                                   | State                                    | Recent and favourite models, variants        | The model store                                                          |
| `session.json`                                                 | State                                    | Pinned session ids                           | The session store                                                        |
| `prompt-history.jsonl`, `prompt-stash.jsonl`, `frecency.jsonl` | State                                    | Prompt history, stash, file-mention frecency | The prompt stores                                                        |
| `tui.json` or `tui.jsonc`                                      | Config, project directories, `.opencode` | Hand-written settings, including `theme`     | The user; the TUI only on plugin install; migration from `opencode.json` |
| `themes/*.json`                                                | Config, `.opencode`                      | Custom themes                                | The user                                                                 |

Sources: the KV store and its atomic write, the model and session stores, the prompt stores, the config loader, and the migration.[^oc-kv][^oc-persistence][^oc-local-model][^oc-local-session][^oc-prompt-stores][^oc-tui-config][^oc-tui-migrate]
KV writes queue in order within one process, and each write replaces the file with a snapshot of the whole store. A failed read is logged, and the TUI
starts with an empty store.[^oc-kv] Two processes that interleave writes would lose one update, because the last full snapshot wins (inferred).

**Directories.** `@opencode-ai/core/global` sets `state` to `xdgState/opencode` and `config` to `xdgConfig/opencode`, and creates both directories on
import.[^oc-global] `xdg-basedir@5.1.0` uses `XDG_STATE_HOME`, else `~/.local/state`, and `XDG_CONFIG_HOME`, else `~/.config`. It has no macOS or
Windows branch.[^xdg] The home directory comes from `os.homedir()`, which on Windows reads `USERPROFILE`.[^node-homedir]

| Platform | `kv.json` (and the other state files)                                                          | Global `tui.json` and `themes/`                                    |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Linux    | `$XDG_STATE_HOME/opencode/kv.json`, else `~/.local/state/opencode/kv.json`                     | `$XDG_CONFIG_HOME/opencode/`, else `~/.config/opencode/`           |
| macOS    | `~/.local/state/opencode/kv.json`, not `~/Library/...`, unless `XDG_STATE_HOME` is set         | `~/.config/opencode/`, unless `XDG_CONFIG_HOME` is set             |
| Windows  | `%USERPROFILE%\.local\state\opencode\kv.json`, not `%APPDATA%`, unless `XDG_STATE_HOME` is set | `%USERPROFILE%\.config\opencode\`, unless `XDG_CONFIG_HOME` is set |

The macOS and Windows rows are inferred from source; they were not observed on those systems. Three related points:

- `OPENCODE_CONFIG_DIR` adds a directory to the `tui.json` search. The KV file and custom-theme discovery use `Global.Path` directly, and it does not
  include that directory.[^oc-global][^oc-tui-config][^oc-theme-discovery]
- The desktop app points `XDG_STATE_HOME` at its own user-data directory for its sidecar. That applies only to the desktop app, not the terminal
  TUI.[^oc-desktop]
- Tips and docs name `~/.config/opencode/tui.json` as the global file.[^oc-tips-view]

**Load order at startup.**

1. **Config files.** The `opencode` TUI command calls `TuiConfig.get()` before rendering.[^oc-cli-tui] The loader merges these layers in order, with
   later layers winning:[^oc-tui-config][^oc-config-paths]
   1. the global config directory's `tui.json` or `tui.jsonc`;
   2. the file named by `OPENCODE_TUI_CONFIG`;
   3. project `tui.json` files found walking up from the working directory, merged starting from the one nearest the root;
   4. `.opencode` directories and `OPENCODE_CONFIG_DIR`.

   A file that is invalid or cannot be read is skipped with a warning. `OPENCODE_DISABLE_PROJECT_CONFIG` turns off the project layers. Before loading,
   legacy `theme`, `keybinds`, and `tui` keys in `opencode.json` are copied into a new `tui.json` wherever none exists yet.[^oc-tui-migrate][^oc-flags]

2. **Renderer.** The renderer is created and the terminal palette fetched early. The app then waits up to 1 s for the terminal's dark or light mode.[^oc-app-boot]
3. **KV.** `KVProvider` reads `kv.json`. The context helper renders no children until `ready`, so nothing below it mounts before the KV file is
   read.[^oc-kv][^oc-helper][^oc-app-boot]
4. **Config.** `TuiConfigProvider` hands the resolved config down.[^oc-app-boot]
5. **Theme.** `ThemeProvider` mounts below the SDK, sync, and data providers.[^oc-theme-context][^oc-app-boot]
   - It sets the active theme to `config.theme`, else KV `theme`, else `opencode`, and the mode as described above.
   - It clears a stale `theme_mode` when the mode is not locked.
   - It resolves the `system` theme and discovers custom themes before it reports `ready`, and its children wait for that.
   - At render, an unregistered active name falls back to KV `theme` and then to `opencode`. A failed discovery resets the active theme to `opencode`.
6. **Models and sessions.** `LocalProvider` reads `model.json` and `session.json` asynchronously. Home's `--prompt` auto-submit waits for the model store
   to be ready.[^oc-local-model][^oc-local-session][^oc-home]

**What this means for the theme.** A `theme` set in `tui.json` wins on every start, and an effect re-applies it whenever the config value changes. A
theme picked in the TUI takes effect and is written to KV, but the next launch replaces it (inferred from the load order).[^oc-theme-context]

## Documentation Drift

OpenCode's docs at the same commit differ from the source in four places. The source is authoritative here.

- The themes page says to use the `/theme` command, while the TUI page and the source use `/themes`. The live docs at opencode.ai, read through Context7
  on the research date, show the same split.[^oc-docs-themes][^oc-docs-tui][^oc-app-commands]
- The themes page gives the working directory's `.opencode/themes` the highest priority. By iteration order, the source gives ancestors priority
  instead.[^oc-docs-themes][^oc-theme-discovery]
- The TUI page documents a `/details` command and a username-display toggle. At this commit, the tool-details toggle has no slash name, and no username
  command exists in `packages/tui/src`; only a tip mentions it.[^oc-docs-tui][^oc-session-commands][^oc-tips-view]

## For Contrast: Secant Today

**The home screen.** Secant's `Home` shows:[^sec-home]

- the title "Secant";
- the Workspace path;
- any startup notices;
- a summary line with installed Bundles, previous Runs, and the first qualified Harness;
- a "Menu" with four entries: Start a Run, Workflow Bundles, Previous Runs, and Harnesses;
- the hint line `↑/↓ move · enter open · q quit`.

Its key bindings are Up, Down, Enter, `q`, and `ctrl+c`, and they are live only after the Workspace is approved and while no dialog is open. There is no
text input, no `/`, no palette, and no settings entry. The file says it was rebuilt against OpenCode's Home at `1ead9e3d7f`, and that it is kept minimal
under ADR 0018's "no dead UI" rule, so every entry dispatches a real action.[^sec-home][^adr-0018]

**The keymap.** Secant builds the same `@opentui/keymap` `0.4.5` keymap through `createDefaultOpenTuiKeymap`. It uses `useBindings` directly and does
not vendor OpenCode's `keymap.tsx` adapter, which is where `useCommandSlashes` and the mode stack live.[^sec-keymap][^sec-package] Home registers key
bindings only, with no named commands.[^sec-home]

**The theme.** Secant's `ThemeProvider` takes a name, uses `nord` when none is given, and falls back to `nord` for an unknown name. It resolves that
theme once, in `dark` mode, and hands down only the theme and its name. It has no store, no KV, no mode detection, and no reload.[^sec-theme-context]

- `app.tsx` mounts `<ThemeProvider>` with no `name`, so every run uses `nord` in dark mode.[^sec-app]
- The vendored `theme.ts` keeps 25 of the 33 upstream assets. It drops the runtime registry (`allThemes`, `addTheme`, subscription), `terminalMode`,
  `generateSystem`, `selectedForeground`, `tint`, and the syntax generators, because no picker uses them.[^sec-theme]
- `resolveTheme` still resolves `light` variants, but nothing asks for light mode.[^sec-theme][^sec-theme-context]

ADR 0018's amendment records `nord` as the default and states there is "no theme picker and no persisted preference yet".[^adr-0018] The reporter's ask
was a `/` command list and theme choice like OpenCode's.[^charting]

## Unknowns

- The per-platform paths were not observed on macOS or Windows. The Windows row assumes Bun's `os.homedir()` matches Node's documented `USERPROFILE`
  behaviour.
- Plugin-supplied commands and themes vary with each install and are not listed here.
- Cross-process behaviour when two TUIs write `kv.json` at once was not tested.

[^oc-home]: OpenCode source, [`routes/home.tsx` lines 16-94](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/home.tsx#L16-L94).

[^oc-builtins]: OpenCode source, [`feature-plugins/builtins.ts` lines 21-36](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/feature-plugins/builtins.ts#L21-L36).

[^oc-footer]: OpenCode source, [`feature-plugins/home/footer.tsx` lines 10-93](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/feature-plugins/home/footer.tsx#L10-L93).

[^oc-tips]: OpenCode source, [`feature-plugins/home/tips.tsx` lines 9-51](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/feature-plugins/home/tips.tsx#L9-L51).

[^oc-tips-view]: OpenCode source, [`feature-plugins/home/tips-view.tsx` lines 6, 176, 213-214, and 273-276](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/feature-plugins/home/tips-view.tsx#L173-L276).

[^oc-prompt-placeholder]: OpenCode source, [`component/prompt/index.tsx` lines 1311-1320](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1311-L1320).

[^oc-prompt-meta]: OpenCode source, [`component/prompt/index.tsx` lines 1444-1484](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1444-L1484).

[^oc-prompt-hints]: OpenCode source, [`component/prompt/index.tsx` lines 1662-1688](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1662-L1688).

[^oc-prompt-shell]: OpenCode source, [`component/prompt/index.tsx` lines 816-860](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L816-L860).

[^oc-prompt-history]: OpenCode source, [`component/prompt/index.tsx` lines 862-928](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L862-L928).

[^oc-prompt-textarea]: OpenCode source, [`component/prompt/index.tsx` lines 1369-1395](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1369-L1395).

[^oc-prompt-submit]: OpenCode source, [`component/prompt/index.tsx` lines 930-1147](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L930-L1147). The autocomplete guard is at line 959, exit words at 963-967, Session creation at 992-1024, server-command dispatch at 1071-1091, and navigation at 1134-1143.

[^oc-prompt-commands]: OpenCode source, [`component/prompt/index.tsx` lines 335-580](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L335-L580).

[^oc-stash-commands]: OpenCode source, [`component/prompt/index.tsx` lines 736-798](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L736-L798).

[^oc-app-commands]: OpenCode source, [`app.tsx` lines 559-960](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L559-L960). Command entries include `theme.switch` at lines 781-789, `theme.switch_mode` at 790-798, `theme.mode.lock` at 799-808, and the KV toggles at 879-945.

[^oc-app-bindings]: OpenCode source, [`app.tsx` lines 92-120 and 962-973](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L962-L973).

[^oc-app-exit-binding]: OpenCode source, [`app.tsx` lines 975-988](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L975-L988), covering the exit binding and `tui.command.execute`.

[^oc-app-signals]: OpenCode source, [`app.tsx` lines 447-450](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L447-L450).

[^oc-app-provider-dialog]: OpenCode source, [`app.tsx` lines 540-549](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L540-L549).

[^oc-app-route]: OpenCode source, [`app.tsx` lines 1112-1121](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L1112-L1121).

[^oc-app-boot]: OpenCode source, [`app.tsx` lines 239-351](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L239-L351). `KVProvider` is at line 284, `TuiConfigProvider` at 296, and `ThemeProvider` at 309.

[^oc-session-commands]: OpenCode source, [`routes/session/index.tsx` lines 465-1099](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L465-L1099). Slash names are at lines 472-474, 510-511, 521-522, 543-544, 565-567, 592-593, 614-615, 651-652, 698-700, 715-717, 920-921, and 950-951; the tool-details toggle without a slash name is at 724-732.

[^oc-session-kv]: OpenCode source, [`routes/session/index.tsx` lines 256-268](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L256-L268) and [`context/thinking.ts` lines 34-36](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/thinking.ts#L34-L36).

[^oc-slashes]: OpenCode source, [`keymap.tsx` lines 49-51 and 250-290](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/keymap.tsx#L250-L290).

[^oc-palette]: OpenCode source, [`component/command-palette.tsx` lines 15-78](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/command-palette.tsx#L15-L78).

[^oc-ac-open]: OpenCode source, [`component/prompt/autocomplete.tsx` lines 109-113 and 643-710](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/autocomplete.tsx#L643-L710).

[^oc-ac-list]: OpenCode source, [`component/prompt/autocomplete.tsx` lines 447-474](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/autocomplete.tsx#L447-L474).

[^oc-ac-filter]: OpenCode source, [`component/prompt/autocomplete.tsx` lines 146-162 and 476-525](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/autocomplete.tsx#L476-L525).

[^oc-ac-select]: OpenCode source, [`component/prompt/autocomplete.tsx` lines 553-558 and 650-661](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/autocomplete.tsx#L650-L661).

[^oc-ac-keys]: OpenCode source, [`component/prompt/autocomplete.tsx` lines 581-641 and 748-766](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/autocomplete.tsx#L581-L641).

[^oc-ac-render]: OpenCode source, [`component/prompt/autocomplete.tsx` lines 527-530 and 712-780](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/autocomplete.tsx#L712-L780).

[^oc-keybinds]: OpenCode source, [`config/keybind.ts` lines 28-239 and the `CommandMap` at 256-409](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/config/keybind.ts#L28-L239). The leader is at line 41, `command_list` at 57, `theme_list` and the mode bindings at 78-80, and the autocomplete keys at 214-218.

[^oc-dialog-select]: OpenCode source, [`ui/dialog-select.tsx` lines 101-114, 154-195, 290-309, 570-597, and 736-760](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/ui/dialog-select.tsx#L154-L195).

[^oc-dialog]: OpenCode source, [`ui/dialog.tsx` lines 105-165](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/ui/dialog.tsx#L105-L165).

[^oc-theme-dialog]: OpenCode source, [`component/dialog-theme-list.tsx` lines 6-50](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/dialog-theme-list.tsx#L6-L50).

[^oc-theme-discovery]: OpenCode source, [`context/theme.tsx` lines 37-61](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/theme.tsx#L37-L61).

[^oc-theme-context]: OpenCode source, [`context/theme.tsx` lines 92-302](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/theme.tsx#L92-L302). Startup choice is at lines 114-130, custom-theme sync at 132-150, the system theme at 155-179, mode pin and free at 202-226, the `SIGUSR2` refresh at 236-246, the fallback at 256-269, and `set` writing KV at 293-297.

[^oc-theme-registry]: OpenCode source, [`theme/index.ts` lines 2-34 and 130-239](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/theme/index.ts#L130-L239).

[^oc-theme-resolve]: OpenCode source, [`theme/index.ts` lines 113-128, 241-299, and 353-360](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/theme/index.ts#L241-L299).

[^oc-kv]: OpenCode source, [`context/kv.tsx` lines 10-66](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/kv.tsx#L10-L66).

[^oc-helper]: OpenCode source, [`context/helper.tsx` lines 3-25](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/helper.tsx#L3-L25).

[^oc-persistence]: OpenCode source, [`util/persistence.ts` lines 22-33](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/util/persistence.ts#L22-L33).

[^oc-local-model]: OpenCode source, [`context/local.tsx` lines 164-245](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/local.tsx#L164-L245).

[^oc-local-session]: OpenCode source, [`context/local.tsx` lines 420-450](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/local.tsx#L420-L450).

[^oc-local-agent]: OpenCode source, [`context/local.tsx` lines 80-118 and 505-520](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/local.tsx#L80-L118).

[^oc-permission]: OpenCode source, [`context/permission.tsx` lines 7-26](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/permission.tsx#L7-L26).

[^oc-prompt-stores]: OpenCode source, [`prompt/history.tsx` line 53](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/prompt/history.tsx#L53), [`prompt/stash.tsx` line 36](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/prompt/stash.tsx#L36), and [`prompt/frecency.tsx` line 42](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/prompt/frecency.tsx#L42).

[^oc-tui-schema]: OpenCode source, [`config/index.tsx` lines 53-136](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/config/index.tsx#L53-L136).

[^oc-which-key]: OpenCode source, [`feature-plugins/system/which-key.tsx` lines 25-26 and 534-575](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/feature-plugins/system/which-key.tsx#L534-L575).

[^oc-plugins]: OpenCode source, [`feature-plugins/system/plugins.tsx` lines 238-261](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/feature-plugins/system/plugins.tsx#L238-L261).

[^oc-diff]: OpenCode source, [`feature-plugins/system/diff-viewer.tsx` lines 1053-1071](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/feature-plugins/system/diff-viewer.tsx#L1053-L1071).

[^oc-plugin-shim]: OpenCode source, [`plugin/command-shim.ts` lines 49-65](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/plugin/command-shim.ts#L49-L65).

[^oc-plugin-state]: OpenCode source, [`plugin/tui/runtime.ts` lines 123, 470-489, and 935-966](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/plugin/tui/runtime.ts#L470-L489). Install targets map to files in [`plugin/install.ts` lines 340-342](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/plugin/install.ts#L340-L342): a `server` target patches `opencode.json` and a `tui` target patches `tui.json`.

[^oc-server-commands]: OpenCode source, [`command/index.ts` lines 46-152](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/command/index.ts#L46-L152).

[^oc-command-dir]: OpenCode source, [`config/command.ts` lines 15-24](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/config/command.ts#L15-L24).

[^oc-cli-tui]: OpenCode source, [`cli/cmd/tui.ts` lines 216-231](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/cli/cmd/tui.ts#L216-L231).

[^oc-tui-config]: OpenCode source, [`config/tui.ts` lines 83-226](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/config/tui.ts#L83-L226). The merge order is at lines 171-210.

[^oc-config-paths]: OpenCode source, [`config/paths.ts` lines 10-45](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/config/paths.ts#L10-L45).

[^oc-tui-migrate]: OpenCode source, [`config/tui-migrate.ts` lines 24-60](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/config/tui-migrate.ts#L24-L60).

[^oc-flags]: OpenCode source, [`flag/flag.ts` lines 50-65](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/core/src/flag/flag.ts#L50-L65).

[^oc-global]: OpenCode source, [`core/src/global.ts` lines 10-43 and 59-72](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/core/src/global.ts#L10-L43).

[^oc-desktop]: OpenCode source, [`desktop/src/main/sidecar.ts` lines 84-90](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/desktop/src/main/sidecar.ts#L84-L90).

[^oc-docs-tui]: OpenCode docs source, [`tui.mdx` lines 64-106, 231-236, and 421-432](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/web/src/content/docs/tui.mdx#L64-L106), published as [opencode.ai/docs/tui](https://opencode.ai/docs/tui).

[^oc-docs-themes]: OpenCode docs source, [`themes.mdx` lines 64 and 81-90](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/web/src/content/docs/themes.mdx#L64-L90), published as [opencode.ai/docs/themes](https://opencode.ai/docs/themes).

[^xdg]: `xdg-basedir@5.1.0`, [`index.js` lines 4-16](https://unpkg.com/xdg-basedir@5.1.0/index.js), pinned by OpenCode [`packages/core/package.json` line 126](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/core/package.json#L126).

[^node-homedir]: Node.js, [`os.homedir()`](https://nodejs.org/api/os.html#oshomedir): "On Windows, it uses the `USERPROFILE` environment variable if defined."

[^keymap-visibility]: `@opentui/keymap@0.4.5`, [`README.md` line 18](https://unpkg.com/@opentui/keymap@0.4.5/README.md) (visibility tiers) and [`src/index.js` lines 1364-1384](https://unpkg.com/@opentui/keymap@0.4.5/src/index.js) (queries default to `reachable`, which draws from the active command view).

[^keymap-enabled]: `@opentui/keymap@0.4.5`, [`src/addons/index.js` lines 659-690](https://unpkg.com/@opentui/keymap@0.4.5/src/addons/index.js) and [`src/opentui.js` lines 118-126](https://unpkg.com/@opentui/keymap@0.4.5/src/opentui.js), where `createDefaultOpenTuiKeymap` registers it.

[^sec-home]: Secant source, [`src/tui/home.tsx` lines 13-128](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/tui/home.tsx#L13-L128).

[^sec-theme-context]: Secant source, [`src/tui/vendor/theme-context.tsx` lines 4-31](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/tui/vendor/theme-context.tsx#L4-L31).

[^sec-theme]: Secant source, [`src/tui/vendor/theme.ts` lines 28-39 and 122-150](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/tui/vendor/theme.ts#L28-L39).

[^sec-app]: Secant source, [`src/tui/app.tsx` lines 350-354](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/tui/app.tsx#L350-L354).

[^sec-keymap]: Secant source, [`src/tui/keymap.ts` lines 1-18](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/tui/keymap.ts#L1-L18).

[^sec-package]: Secant [`package.json` lines 64-66](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/package.json#L64-L66); OpenCode's catalog pins the same `0.4.5` in its root [`package.json` lines 43-45](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/package.json#L43-L45).

[^adr-0018]: Secant [ADR 0018 lines 33-40 and 99-107](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/adr/0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md#L99-L107).

[^charting]: [Charting record on #235](https://github.com/secantdev/secant/issues/235#issuecomment-5855568126), section "Raised during charting".

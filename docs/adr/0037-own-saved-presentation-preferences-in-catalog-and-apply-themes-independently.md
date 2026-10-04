# Own Saved Presentation Preferences in Catalog and Apply Themes Independently

Secant adds saved **Preferences** for theme and dark or light appearance, shared across Workspaces within one Secant home. The human confirmed the
home launcher, theme picker, and headless settings behavior on
[Decide what the home screen offers: commands and settings](https://github.com/secantdev/secant/issues/246); that ticket holds the UX decision.

Application owns preference reads and changes through the existing Projection Port, and Catalog owns their persistence in `catalog.db`. Composition
supplies the resolved Secant home. Catalog already stores home-wide Workspace approvals, so extending that owner keeps transaction ordering,
validation, and failure translation in one place without introducing another storage system or allowing presentation to own durable files. This
extends [ADR 0025](./0025-organize-target-code-around-owned-deep-modules.md)'s Catalog responsibility. TUI and headless settings use the same
Application Interface; the TUI command catalog, search, focus, theme assets, and rendering remain presentation concerns.

Applying an appearance is independent of saving Preferences. TUI preview and confirmed appearance are local presentation state; successful saves
change the durable Preferences. A failed save reports that the choice was not saved and leaves the chosen appearance active. Missing or unsupported
preference values use everforest and dark appearance; a preference read failure reports a notice and uses those defaults, while a failure affecting
the whole Catalog retains its existing handling. Updates preserve unrelated preferences atomically, with the latest committed change winning for
the same preference. Other running instances adopt saved changes on their next launch; cross-process live synchronization is outside this decision.
The save-failure, read-failure, and latest-wins rules also cover the last Model choice per Harness (2026-10-04, #343).

The defaults are everforest, as decided in [ADR 0036](./0036-the-run-workbench-mirrors-the-agent.md), and dark appearance. The picker uses the 25
existing vendored themes and their existing dark and light palettes. This supersedes ADR 0018's initial fixed-theme, no-picker, no-persistence choice;
its vendor and attribution rules remain in force. Custom theme files, automatic terminal-mode detection, and animation or mouse settings are deferred.

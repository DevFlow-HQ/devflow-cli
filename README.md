# Secant

Secant helps you plan and build software with a coding agent. The included **Matt Front Spec** workflow turns an idea into a spec and tickets, then helps you work through the tickets one at a time.

## Install

Mac or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/secantdev/secant/main/install.sh | sh
```

Windows:

```powershell
irm https://raw.githubusercontent.com/secantdev/secant/main/install.ps1 | iex
```

Or install with npm:

```sh
npm install -g @secantdev/secant
```

You can also download Secant from the [latest release](https://github.com/secantdev/secant/releases/latest). See [supported platforms](./docs/support-matrix.md).

## Get started

Install and sign in to either Claude Code or Codex. Open a new terminal in the project you want to work on, then run:

```sh
secant
```

Approve the folder, choose **Start a Run** → **Matt Front Spec**, pick your coding agent, and describe your idea.

Run `secant --help` to see other commands, including how to install your own workflows and revisit earlier runs.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Coding agents working in this repository start with [AGENTS.md](./AGENTS.md).

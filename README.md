# MCPM

MCPM is an open-source command-line package manager for Minecraft: Java Edition
mod projects. It manages mods through the Modrinth API and is being extended with
an optional direct launcher feature.

> **Project status:** mod management is functional. Direct Microsoft account
> authentication is implemented, but the MCPM App ID is awaiting approval for
> access to the Minecraft Services API. MCPM does not attempt to bypass that
> review process.

## Requirements

- Node.js 18 or newer
- Windows for secure launcher account storage (DPAPI)

## Installation

Run these commands in the repository directory:

```text
npm install
npm link
```

After `npm link`, the `mcpm` command is available from any directory. The global
link points to this working copy, so later code changes do not require another
installation.

## Commands

```text
mcpm init
mcpm use <name-or-path>
mcpm projects
mcpm current
mcpm forget <name-or-path>
mcpm config
mcpm config --beta on
mcpm config --beta off
mcpm search <query>
mcpm install <slug>
mcpm remove <slug>
mcpm update
mcpm upgrade <version>
mcpm list
```

Run `mcpm --help` or `mcpm <command> --help` for detailed command documentation.

## Project registry

Every project created with `mcpm init` is registered automatically and becomes
the active project. This allows MCPM commands to run from any directory:

```text
mcpm projects
mcpm use my-modpack
mcpm use D:\Minecraft\modpacks\survival
```

`projects` lists every known project and marks the active one. `use` switches the
active project; providing the path to an unregistered project adds it to the
registry at the same time. `current` displays the project that the current
command would use. `forget` removes only the global registry entry and never
deletes project configuration, lock files, or mods.

When a command runs inside an MCPM project or one of its subdirectories, that
local project takes precedence over the globally active project. Set
`MCPM_PROJECT` to override both for a single command.

The registry is stored in `~/.mcpm/projects.json`. Automation can override the
state directory with `MCPM_STATE_DIR`.

## Beta versions

Beta support is configured separately for each project, so `--beta` does not
have to be added to every command:

```text
mcpm use my-modpack
mcpm config --beta on
mcpm update
```

Use `mcpm config` to inspect the current value. Passing `--beta` to `install`,
`update`, or `upgrade` still enables beta versions for that one command when the
project default is off. Alpha releases are never selected automatically.

## Updating mods and upgrading Minecraft

`mcpm update` updates directly declared mods for the project's current Minecraft
version. Each mod is handled independently. If one mod has no compatible
version, MCPM reports it in the summary and continues updating the others.

`mcpm upgrade <version>` changes the project's Minecraft version. MCPM resolves
and prepares a complete compatible mod set before replacing existing files.

## Optional features

Larger capabilities can be installed independently of the MCPM core:

```text
mcpm feature list
mcpm feature install launcher
mcpm launcher status
mcpm launcher login
mcpm launcher account
mcpm launcher logout
mcpm feature uninstall launcher
```

The `launcher` feature is a separate `@mcpm/feature-launcher` package loaded from
`~/.mcpm/features`. It provides project diagnostics and device-code sign-in
through Microsoft, Xbox Live, and Minecraft Services. The account is shared by
all MCPM projects, and its saved session is encrypted with Windows DPAPI. Runtime
downloads and the final `mcpm launch` command are not implemented yet.

## Application information

- **Application name:** MCPM Launcher
- **Owner and publisher:** Maciej Wlodarski (`MaciejWlodarski`)
- **Microsoft Application (client) ID:** `51b43610-2c23-4923-8378-e2a011ed16e4`
- **Platform:** open-source Windows CLI; the launcher is an optional MCPM feature
- **License:** MIT
- **Source:** this repository

### Purpose

The optional launcher is intended to let users authenticate their own licensed
Minecraft: Java Edition account and eventually start the Minecraft version and
mod loader configured by their local MCPM project. It is not an account-linking,
verification, resale, credential-collection, or hosted authentication service.

### Microsoft and Minecraft authentication

MCPM uses Microsoft OAuth 2.0 Device Code Flow as a public client. It requests
only `XboxLive.signin` and `XboxLive.offline_access`. Users enter the code on
Microsoft's website; MCPM never displays, receives, or stores their password.

After Microsoft authorization, MCPM performs the standard local authentication
chain:

1. Microsoft OAuth access and refresh token
2. Xbox Live user token
3. Xbox Secure Token Service (XSTS) token
4. Minecraft Services access token
5. Minecraft entitlement and profile lookup

The implementation is available in
[`features/launcher/src/auth.js`](features/launcher/src/auth.js). There is no MCPM
authentication server, and tokens are never sent to the project owner or any
MCPM-controlled service.

### Privacy and token storage

- Authentication data remains on the user's computer.
- On Windows, the complete saved session is encrypted with DPAPI using the
  `CurrentUser` scope before it is written to disk.
- Atomic file replacement prevents partially written credential files.
- `mcpm launcher logout` deletes the saved session.
- MCPM does not collect analytics, passwords, email addresses, access tokens, or
  refresh tokens.
- Network requests are made only to Microsoft, Xbox Live, Minecraft Services,
  Modrinth, and download URLs selected from Modrinth metadata.

The encrypted storage implementation is available in
[`features/launcher/src/secure-storage.js`](features/launcher/src/secure-storage.js).
New App IDs must be approved manually by Minecraft Services through the official
[Java Edition application review process](https://aka.ms/mce-reviewappid).

## Transaction safety

Downloads are written to a temporary directory first. MCPM replaces old files
and saves `mcpm.json` and `mcpm-lock.json` only after preparing the complete
operation. If an error occurs, it restores the previous files and project state.

A required dependency cannot be removed. If it was also installed directly,
`remove` converts it back to a dependency instead.

## Development

```text
npm test
npm run check
```

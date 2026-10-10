# @mcpm/feature-launcher

Optional direct Minecraft launching for MCPM profiles.

## Installation

Install the MCPM CLI from [release v1.1.0](https://github.com/MaciejWlodarski/mcpm/releases/tag/v1.1.0):

```sh
npm install --global https://github.com/MaciejWlodarski/mcpm/releases/download/v1.1.0/mcpm-1.1.0.tgz
```

Download `mcpm-feature-launcher-0.3.0.tgz` from the same release. Choose a
permanent location for the `mcpm-launcher` directory, then run these commands
from the directory containing the downloaded package:

```sh
npm install --prefix ./mcpm-launcher ./mcpm-feature-launcher-0.3.0.tgz
mcpm feature install launcher --source ./mcpm-launcher/node_modules/@mcpm/feature-launcher
mcpm launcher --help
```

Keep the `mcpm-launcher` directory after installation. The release page also
provides an installation guide and SHA-256 checksums. Node.js 18 or newer with
npm is required; the release package is already compiled.

Microsoft sign-in and account storage support Windows and macOS. Managing mods
and preparing runtime files do not require sign-in. Direct launching requires
a licensed Minecraft: Java Edition Microsoft account.

## Development

Run `npm ci`, `npm run check`, and `npm run build` in this directory to work on
the launcher independently. The TypeScript source is compiled into `dist`,
which is the Feature API entry point included in the release package.
`npm pack` builds the package automatically. When developing from the MCPM
repository, the root `npm run build` builds both the CLI and launcher.

## Commands

```text
mcpm profiles
mcpm profile <name-or-path>
mcpm launcher status [profile]
mcpm launcher prepare [profile]
mcpm launcher login
mcpm launcher login --storage=file
mcpm launcher login --storage=keychain
mcpm launcher account
mcpm launcher account --refresh
mcpm launcher logout
mcpm launch [profile]
```

Every MCPM project is a launch profile. The project keeps its own version,
loader, mods, game configuration, and saves, while downloaded Minecraft files,
libraries, assets, and Java runtimes are cached globally under
`~/.mcpm/launcher`.

The launcher currently supports vanilla metadata and Fabric Loader profiles.
Forge, NeoForge, and Quilt projects remain fully manageable by MCPM, but direct
launching fails explicitly until their runtime adapters are implemented.

## Authentication

`login` uses Microsoft Device Code Flow and exchanges the result through Xbox
Live, XSTS, and Minecraft Services. The account is shared by all profiles. On
Windows, the refresh token and Minecraft session are encrypted for the current
user with DPAPI. On macOS, MCPM uses the native Keychain through the `SecItem`
API by default. If a user's login Keychain is unavailable, they may explicitly
select `--storage=file`. The fallback stores the session atomically with
user-only filesystem permissions (`0600`, inside a `0700` credentials
directory). Processes running as the same macOS user can read that fallback
file, so protect the account with a strong password and FileVault.
The selected backend is remembered for later sign-ins and session refreshes,
including after logout. Use `--storage=keychain` to switch back to Keychain.

The public MCPM client ID can be overridden during development with
`MCPM_MICROSOFT_CLIENT_ID`.

## Runtime preparation

`mcpm launcher prepare [profile]` downloads and verifies:

- Mojang version metadata and the client JAR
- platform-appropriate libraries and native archives
- the asset index and all referenced asset objects
- a stable Fabric Loader profile and its Maven libraries
- the Mojang Java component required by the selected Minecraft version

The launch command evaluates Mojang OS and feature rules, extracts native files
with path traversal protection, connects the MCPM-managed mod directory to the
profile, refreshes authentication when necessary, and starts Java without a
shell.

Persistent relative Java paths are resolved against the profile directory.
Memory and game-directory settings are validated before they are saved, and
recursive mod-directory links are rejected.

Use `mcpm launch --prepare-only` to populate the cache without signing in, or
`mcpm launch --dry-run` to validate the complete authenticated launch plan
without starting Minecraft.

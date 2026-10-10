# MCPM

MCPM is an open-source command-line package manager and launcher for Minecraft:
Java Edition mod profiles. It resolves mods through Modrinth, keeps every profile
isolated, and can download and launch Minecraft directly without the official
launcher.

> **Project status:** mod management, Microsoft authentication, profile
> management, Mojang runtime installation, and direct vanilla/Fabric launching are
> functional. Forge, NeoForge, and Quilt launch adapters are not implemented yet.

## Requirements

- Node.js 18 or newer with npm.
- Mod management supports Windows, macOS, and Linux.
- Microsoft sign-in and account storage support Windows (DPAPI) and macOS
  (Keychain, with an explicit file-storage fallback).
- Direct launching requires a licensed Minecraft: Java Edition Microsoft
  account. Managing mods and preparing runtime files do not require sign-in.

Java does not need to be installed manually. MCPM uses a compatible system Java
when available and otherwise downloads the runtime specified by Mojang metadata.

## Installation

### Install the CLI from the release

[MCPM v1.1.0](https://github.com/MaciejWlodarski/mcpm/releases/tag/v1.1.0)
includes ready-to-install packages. Install the CLI directly from GitHub:

```sh
npm install --global https://github.com/MaciejWlodarski/mcpm/releases/download/v1.1.0/mcpm-1.1.0.tgz
mcpm --version
```

The release contains compiled JavaScript and type declarations; Node.js and
npm are sufficient to install it. You can also download `mcpm-1.1.0.tgz` and run
`npm install --global ./mcpm-1.1.0.tgz` in the download directory.

The release page includes an [installation guide](https://github.com/MaciejWlodarski/mcpm/releases/download/v1.1.0/INSTALL.md)
and `SHA256SUMS.txt` for verifying the downloaded files.

### Install the optional launcher

Download `mcpm-feature-launcher-0.3.0.tgz` from the same release. Choose a
permanent location for the `mcpm-launcher` directory, then run these commands
from the directory containing the downloaded package:

```sh
npm install --prefix ./mcpm-launcher ./mcpm-feature-launcher-0.3.0.tgz
mcpm feature install launcher --source ./mcpm-launcher/node_modules/@mcpm/feature-launcher
mcpm launcher --help
```

Keep the `mcpm-launcher` directory after installation. The launcher adds
`mcpm launcher`, `mcpm launch`, `mcpm profiles`, and `mcpm profile` commands.

### Install from source

For development, run these commands in the repository directory:

```sh
npm ci
npm run build
npm link
mcpm feature install launcher
```

After `npm link`, `mcpm` is available from any directory. The global link points
to this working copy. Run `npm run build` after local TypeScript changes; another
core installation is not needed. Reinstall the optional launcher feature after
changing its package source.

## Quick start

Create a project/profile in the directory that should contain saves, config,
logs, resource packs, and mods.

For this example, select Fabric when `init` asks for a loader. Initialization
registers the project and makes it active:

```sh
mcpm init ./my-modpack
mcpm install fabric-api
mcpm install sodium
mcpm list
```

With the [optional launcher installed](#install-the-optional-launcher), sign in
and start the active profile:

```sh
mcpm launcher login
mcpm launch
```

The first launch downloads the Minecraft client, libraries, native files, asset
index, assets, Fabric Loader, and a compatible Mojang Java runtime. These files
are cached globally and reused by other profiles.

## Commands

The core CLI provides these commands:

```text
mcpm init [path]
mcpm projects
mcpm use <name-or-path>
mcpm current
mcpm forget <name-or-path>

mcpm config
mcpm config --beta on
mcpm config --memory 6G
mcpm config --resolution 1600x900
mcpm config --java C:\Java\jdk-25
mcpm config --java auto
mcpm config --game-dir ./game

mcpm feature list
mcpm feature install launcher --source <package-directory>
mcpm feature uninstall launcher

mcpm search <query>
mcpm install <slug>
mcpm add-file <path-to-jar>
mcpm open-mods [profile]
mcpm remove <slug>
mcpm update
mcpm upgrade <version>
mcpm upgrade <version> --check
mcpm upgrade <version> --loader fabric
mcpm list
```

With the optional launcher installed:

```text
mcpm profiles
mcpm profile <name-or-path>
mcpm launcher status [profile]
mcpm launcher prepare [profile]
mcpm launcher login
mcpm launcher login --storage=file
mcpm launcher account
mcpm launcher account --refresh
mcpm launcher logout
mcpm launch [profile]
mcpm launch [profile] --prepare-only
mcpm launch [profile] --dry-run
mcpm launch [profile] --detach
```

Run `mcpm --help` or `mcpm <command> --help` for all options.

## Projects are launch profiles

The project registry is also the launch-profile registry. Each project stores
its own:

- Minecraft version and loader
- direct mods and resolved dependency lockfile
- beta-release policy
- game directory, saves, config, logs, screenshots, and resource packs
- Java, memory, and resolution overrides

The core commands `mcpm projects` and `mcpm use <name-or-path>` list and select
projects. With the launcher installed, `mcpm profiles` adds runtime status and
`mcpm profile <name-or-path>` selects the active launch profile. You can also
launch a specific profile without changing the active one:

```text
mcpm launch hypixel-skyblock
```

When a command runs inside an MCPM project or its subdirectory, the local profile
takes precedence over the globally active profile. `MCPM_PROJECT` overrides both
for one command.

The registry is stored at `~/.mcpm/projects.json`. Set `MCPM_STATE_DIR` to move
all global MCPM state for automation or tests.

### Game and mod directories

The project directory is the game directory by default. If `gameDir` and
`modsDir` point to different locations, MCPM safely connects the game profile's
`mods` directory to the MCPM-managed mod directory using a directory link. It
refuses to replace a non-empty unmanaged directory.

### Manual mods

Run `mcpm open-mods` to open the current profile's configured mods directory in
Finder, Explorer, or the Linux file manager. `mcpm open-mods <name-or-path>` opens
another profile without changing the active one. A missing mods directory is
created automatically.

You can drop local `.jar` files into that folder or copy one with
`mcpm add-file "/path/to/My Mod.jar"`. This keeps the source file and refuses to
replace an existing JAR or a filename already managed by MCPM.

`mcpm list` discovers JARs whose filenames are absent from the MCPM lockfile and
labels them as manual mods with unknown compatibility. These files stay outside
the managed mod list and are not automatically updated or removed. To remove a
manual mod, delete its JAR from the folder.

`upgrade --check` lists manual JARs as excluded from the check. Its compatibility
result and exit status refer only to managed mods. A regular upgrade leaves
manual JARs unchanged and lists the files that it did not update.

## Updating and upgrading

`mcpm update` checks every direct mod for the profile's current Minecraft
version. Incompatible mods are pinned to their installed versions and reported
without stopping compatible updates. MCPM then resolves and applies one shared
dependency graph, so updating one mod cannot silently break another mod's
required dependencies.

Installing a mod also resolves the shared graph while preserving the versions
of existing direct mods. Partial updates keep compatible installed versions in
that graph, including mods skipped because of a conflict. If the installed
version of a skipped mod cannot be verified, MCPM leaves the profile unchanged.
Declared Modrinth incompatibilities and conflicting exact dependency versions
block the plan before any files are replaced.

If an operation fails and restoring the previous files also fails, MCPM keeps
the remaining backups in its staging directory and prints the recovery path.

`mcpm upgrade <version>` performs a profile migration. MCPM resolves a complete
compatible graph of managed mods for the new Minecraft version before replacing
any files or saving the new configuration. `--loader <loader>` changes the
loader in the same transaction. The next launch automatically prepares the
matching game and loader runtime from the shared cache.

Use `mcpm upgrade <version> --check` to resolve the migration without downloading
JARs or changing any profile files. It prints the target mod versions or reports
blocking direct mods and conflicts in the shared dependency plan. `--loader` and
`--beta` also apply to the check. Exit status is `0` for a compatible plan and `1`
when the plan is blocked or cannot be verified. Compatibility is based on
Modrinth metadata; this check does not test game execution. Exact dependency
constraints take precedence over an unconstrained latest version, regardless of
the order of mods in the profile.

Beta support is persistent per profile:

```text
mcpm config --beta on
mcpm update
```

Passing `--beta` to `install`, `update`, or `upgrade` enables beta versions for
that operation. Alpha releases are never selected automatically.

## Direct launcher

The launcher is an optional `@mcpm/feature-launcher` package loaded from
`~/.mcpm/features`. Follow [the launcher installation instructions](#install-the-optional-launcher)
above before using its commands.

```text
mcpm launcher login
mcpm launcher account
mcpm launcher prepare hypixel-skyblock
mcpm launch hypixel-skyblock
```

`launch` performs these steps:

1. Resolves the profile and validates its loader.
2. Reads the official Mojang version manifest.
3. Resolves a stable Fabric Loader profile from Fabric Meta.
4. Downloads and verifies the client, libraries, native archives, and assets.
5. Selects or downloads the required Java major version.
6. Refreshes the Minecraft session when necessary.
7. Builds the JVM and game arguments without invoking a shell.
8. Starts Minecraft in the profile game directory.

Useful launch options:

- `--prepare-only` downloads everything without requiring an account or starting
  the game.
- `--dry-run` refreshes authentication and validates the complete launch command
  without starting Java. Tokens are never printed.
- `--detach` starts Minecraft in the background.
- `--memory 6G`, `--width 1600`, and `--height 900` override profile settings for
  one launch.
- `--java <path>` selects a Java executable or Java home for one launch.
- `--server <address>` connects to a multiplayer server after startup.

Downloaded runtime data is shared under `~/.mcpm/launcher`; profile saves and
configuration remain in the project game directory.

## Application and authentication information

- **Application name:** MCPM Launcher
- **Owner and publisher:** Maciej Wlodarski (`MaciejWlodarski`)
- **Microsoft Application (client) ID:** `51b43610-2c23-4923-8378-e2a011ed16e4`
- **License:** MIT
- **Source:** this repository

MCPM uses Microsoft OAuth 2.0 Device Code Flow as a public client and requests
only `XboxLive.signin` and `XboxLive.offline_access`. Users enter the code on
Microsoft's website; MCPM never receives their password.

The local authentication chain is:

1. Microsoft OAuth access and refresh token
2. Xbox Live user token
3. Xbox Secure Token Service (XSTS) token
4. Minecraft Services access token
5. Minecraft entitlement and profile lookup

There is no MCPM authentication server. On Windows, the saved session is
encrypted with DPAPI in the `CurrentUser` scope. On macOS, it is stored in
Keychain by default. If Keychain is unavailable, explicitly select
`mcpm launcher login --storage=file` to use a plaintext session file protected
by `0600` permissions in a `0700` credentials directory. Processes running as
your macOS user can read this fallback. The backend selection is remembered,
including after logout; `--storage=keychain` switches back to Keychain.
`mcpm launcher logout` removes the saved session. MCPM does not collect
analytics, passwords, email addresses, or tokens.

## Transaction and download safety

- Mod changes are staged before the existing profile is replaced.
- Configuration and lock files are written atomically.
- Failed mod migrations restore the previous files and project state.
- Runtime downloads use temporary files and atomic replacement.
- Mojang and Fabric downloads are checked against published sizes and SHA-1
  hashes when metadata provides them.
- Cached files are revalidated, and metadata-derived paths cannot escape the
  shared launcher cache.
- Archive paths are validated before native libraries are extracted.
- A required mod dependency cannot be removed while another mod needs it.

## Development

```text
npm ci
npm run build
npm test
npm run check
```

The CLI, optional launcher, and tests are written in TypeScript with strict type
checking. `npm run build` compiles the CLI into `dist/bin` and `dist/src`, and
the separate launcher package into `features/launcher/dist`. Both release
packages contain JavaScript and type declarations, so users only need Node.js
18 or newer. TypeScript is a development dependency.

`npm test` builds both packages and compiles the regression tests into
`test-dist` before running them against the compiled packages. `npm run check`
builds both packages and checks the tests and compile-time contracts in
`type-tests`. Test output is excluded from published packages.
`npm pack` builds automatically before creating a package. To build the launcher
independently, run `npm ci` and `npm run build` inside `features/launcher`.

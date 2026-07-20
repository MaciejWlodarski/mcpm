# MCPM

MCPM is an open-source command-line package manager and launcher for Minecraft:
Java Edition mod profiles. It resolves mods through Modrinth, keeps every profile
isolated, and can download and launch Minecraft directly without the official
launcher.

> **Project status:** mod management, Microsoft authentication, profile
> management, Mojang runtime installation, and direct Fabric launching are
> functional. Forge, NeoForge, and Quilt launch adapters are not implemented yet.

## Requirements

- Node.js 18 or newer
- Windows for secure account storage through DPAPI
- A licensed Minecraft: Java Edition Microsoft account

Java does not need to be installed manually. MCPM uses a compatible system Java
when available and otherwise downloads the runtime specified by Mojang metadata.

## Installation

Run these commands in the repository directory:

```text
npm install
npm link
mcpm feature install launcher
```

After `npm link`, `mcpm` is available from any directory. The global link points
to this working copy, so later local code changes do not require another core
installation. Reinstall the optional launcher feature after changing its package
source.

## Quick start

Create a project/profile in the directory that should contain saves, config,
logs, resource packs, and mods:

```text
mcpm init C:\Minecraft\profiles\my-modpack
mcpm profile my-modpack
mcpm install fabric-api
mcpm install sodium
mcpm launcher login
mcpm launch
```

The first launch downloads the Minecraft client, libraries, native files, asset
index, assets, Fabric Loader, and a compatible Mojang Java runtime. These files
are cached globally and reused by other profiles.

## Commands

```text
mcpm init [path]
mcpm projects
mcpm profiles
mcpm use <name-or-path>
mcpm profile <name-or-path>
mcpm current
mcpm forget <name-or-path>

mcpm config
mcpm config --beta on
mcpm config --memory 6G
mcpm config --resolution 1600x900
mcpm config --java C:\Java\jdk-25
mcpm config --java auto

mcpm search <query>
mcpm install <slug>
mcpm remove <slug>
mcpm update
mcpm upgrade <version>
mcpm upgrade <version> --loader fabric
mcpm list

mcpm launcher status [profile]
mcpm launcher prepare [profile]
mcpm launch [profile]
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

`mcpm profiles` lists profiles. `mcpm profile <name>` selects the active profile;
the older `projects` and `use` commands remain available. You can also launch a
specific profile without changing the active one:

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

## Updating and upgrading

`mcpm update` checks every direct mod for the profile's current Minecraft
version. Incompatible mods are pinned to their installed versions and reported
without stopping compatible updates. MCPM then resolves and applies one shared
dependency graph, so updating one mod cannot silently break another mod's
required dependencies.

`mcpm upgrade <version>` performs a profile migration. MCPM resolves a complete
compatible mod graph for the new Minecraft version before replacing any files or
saving the new configuration. `--loader <loader>` changes the loader in the same
transaction. The next launch automatically prepares the matching game and loader
runtime from the shared cache.

Beta support is persistent per profile:

```text
mcpm config --beta on
mcpm update
```

Passing `--beta` to `install`, `update`, or `upgrade` enables beta versions for
that operation. Alpha releases are never selected automatically.

## Direct launcher

The launcher is an optional `@mcpm/feature-launcher` package loaded from
`~/.mcpm/features`.

```text
mcpm feature install launcher
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
encrypted with DPAPI in the `CurrentUser` scope. `mcpm launcher logout` deletes
it. MCPM does not collect analytics, passwords, email addresses, or tokens.

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
npm test
npm run check
```

# @mcpm/feature-launcher

Optional direct Minecraft launching for MCPM profiles.

## Commands

```text
mcpm profiles
mcpm profile <name-or-path>
mcpm launcher status [profile]
mcpm launcher prepare [profile]
mcpm launcher login
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
user with DPAPI.

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

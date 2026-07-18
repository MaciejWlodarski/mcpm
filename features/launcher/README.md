# @mcpm/feature-launcher

An optional MCPM feature that prepares projects for launching Minecraft directly.

The current release provides:

```text
mcpm launcher status
mcpm launcher login
mcpm launcher account
mcpm launcher account --refresh
mcpm launcher logout
```

`login` uses Microsoft Device Code Flow, then exchanges the token through Xbox
Live, XSTS, and Minecraft Services. The account is shared by all MCPM projects.
On Windows, the refresh token and Minecraft session are encrypted for the current
user with DPAPI.

The MCPM application client ID is public. During development, it can be
overridden with the `MCPM_MICROSOFT_CLIENT_ID` environment variable.

Minecraft Services manually approves new client applications. Before the first
successful sign-in, the App ID must be accepted through the Java Edition
application review form: https://aka.ms/mce-reviewappid. Without approval, the
final token exchange returns `Invalid app registration` even when Microsoft and
Xbox authentication succeeds.

Runtime downloading and the final `mcpm launch` command will be added in later
development stages.

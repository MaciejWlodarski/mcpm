import type { FeatureApi, ProjectConfig, Lockfile, CheckResult } from '../src/types.js';
import type { FeatureApi as LauncherFeatureApi } from '../features/launcher/src/types.js';
import type { LaunchResult } from '../features/launcher/src/launch.js';

declare const coreApi: FeatureApi;
const launcherApi: LauncherFeatureApi = coreApi;
void launcherApi;

const config: ProjectConfig = {
  minecraftVersion: '1.21.1', loader: 'fabric', modsDir: './mods', mods: {}, allowBeta: false
};
// @ts-expect-error Persisted beta settings are booleans, unlike the CLI's on/off strings.
config.allowBeta = 'on';

const legacyLock: Lockfile = {
  minecraftVersion: '1.21.1', loader: 'fabric',
  installed: { sodium: { title: 'Sodium', slug: 'sodium', version: '0.6.0', filename: 'sodium.jar' } }
};
void legacyLock;

declare const check: CheckResult;
if (check.compatible) check.plan.items.size;
// @ts-expect-error A failed compatibility check can have no installable plan.
check.plan.items.size;

declare const launch: LaunchResult;
if (launch.mode === 'dry-run') launch.command.args.length;
// @ts-expect-error Preparation does not create a game launch command.
if (launch.mode === 'prepared') launch.command.args.length;

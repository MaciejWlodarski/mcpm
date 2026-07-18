import pc from 'picocolors';
import { installFeature, listFeatures, uninstallFeature } from '../features.js';

export async function featureListCommand() {
  const features = await listFeatures();
  console.log(pc.bold('Optional MCPM features:'));
  for (const feature of features) {
    const status = feature.installed
      ? pc.green(`installed (${feature.version})`)
      : pc.gray('not installed');
    console.log(`  ${pc.cyan(feature.name)}: ${status}`);
  }
  return features;
}

export async function featureInstallCommand(name, options = {}) {
  console.log(pc.cyan(`Installing optional feature ${pc.bold(name)}...`));
  const feature = await installFeature(name, options);
  console.log(pc.green(
    `Feature ${pc.bold(feature.name)} ${feature.version} was installed. ` +
    'Its commands will be available the next time MCPM starts.'
  ));
  return feature;
}

export async function featureUninstallCommand(name) {
  const feature = await uninstallFeature(name);
  console.log(pc.green(`Feature ${pc.bold(feature.name)} was uninstalled.`));
  return feature;
}

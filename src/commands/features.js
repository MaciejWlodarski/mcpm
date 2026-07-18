import pc from 'picocolors';
import { installFeature, listFeatures, uninstallFeature } from '../features.js';

export async function featureListCommand() {
  const features = await listFeatures();
  console.log(pc.bold('Opcjonalne feature’y MCPM:'));
  for (const feature of features) {
    const status = feature.installed
      ? pc.green(`zainstalowany (${feature.version})`)
      : pc.gray('niezainstalowany');
    console.log(`  ${pc.cyan(feature.name)}: ${status}`);
  }
  return features;
}

export async function featureInstallCommand(name, options = {}) {
  console.log(pc.cyan(`Instalowanie opcjonalnego feature’a ${pc.bold(name)}...`));
  const feature = await installFeature(name, options);
  console.log(pc.green(
    `Feature ${pc.bold(feature.name)} ${feature.version} został zainstalowany. ` +
    'Jego komendy będą dostępne przy następnym uruchomieniu MCPM.'
  ));
  return feature;
}

export async function featureUninstallCommand(name) {
  const feature = await uninstallFeature(name);
  console.log(pc.green(`Feature ${pc.bold(feature.name)} został odinstalowany.`));
  return feature;
}

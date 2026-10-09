import { spawn } from 'child_process';

export function openDirectory(directory, services = {}) {
  const platform = services.platform || process.platform;
  const executable = { darwin: 'open', win32: 'explorer.exe', linux: 'xdg-open' }[platform];
  if (!executable) throw new Error(`Opening folders is not supported on ${platform}.`);
  return new Promise((resolve, reject) => {
    const child = (services.spawn || spawn)(executable, [directory], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true
    });
    child.once('error', reject);
    if (platform === 'win32') {
      // Explorer delegates the folder to the running desktop process.
      child.once('spawn', () => { child.unref(); resolve(); });
    } else {
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Could not open the folder (${executable}: ${signal || code}).`));
      });
    }
  });
}

export function filenameKey(filename: string, platform: string = process.platform) {
  return ['darwin', 'win32'].includes(platform)
    ? filename.normalize('NFC').toLowerCase()
    : filename;
}

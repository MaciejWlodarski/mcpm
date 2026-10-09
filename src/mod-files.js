export function filenameKey(filename, platform = process.platform) {
  return ['darwin', 'win32'].includes(platform)
    ? filename.normalize('NFC').toLowerCase()
    : filename;
}

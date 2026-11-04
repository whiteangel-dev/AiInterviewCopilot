/* eslint-disable no-console */
// Builds the Rust crate (release) and copies the library to ./aic_native_audio.node
// and to the desktop app's resources: apps/desktop/resources/native/<platform>-<arch>/.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
execFileSync('cargo', ['build', '--release'], { stdio: 'inherit', cwd: here });

const lib =
  { win32: 'aic_native_audio.dll', darwin: 'libaic_native_audio.dylib' }[process.platform] ??
  'libaic_native_audio.so';
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(here, process.env.CARGO_TARGET_DIR)
  : join(here, 'target');
const built = join(targetDir, 'release', lib);

const outputs = [
  join(here, 'aic_native_audio.node'),
  join(
    here,
    '../../apps/desktop/resources/native',
    `${process.platform}-${process.arch}`,
    'aic_native_audio.node',
  ),
];
for (const output of outputs) {
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(built, output);
  console.log(`copied ${built} -> ${output}`);
}

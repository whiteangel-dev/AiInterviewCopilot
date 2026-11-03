// Builds the Rust crate and copies the shared library to ./aic_native_audio.node.
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';

execFileSync('cargo', ['build', '--release'], { stdio: 'inherit' });
const lib = { win32: 'aic_native_audio.dll', darwin: 'libaic_native_audio.dylib' }[process.platform] ?? 'libaic_native_audio.so';
copyFileSync(new URL(`./target/release/${lib}`, import.meta.url), new URL('./aic_native_audio.node', import.meta.url));
console.log('built aic_native_audio.node');

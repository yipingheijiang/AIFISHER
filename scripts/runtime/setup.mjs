// Local setup uses the already installed, verified official Node; it downloads nothing.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== manifest.engines.node) {
  throw new Error(`Run this setup with the installed Windows x64 Node.js ${manifest.engines.node}; see the installation guide.`);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = manifest.aifisherRuntime.winX64Sha256;
if (digest(await readFile(process.execPath)) !== expected) throw new Error('Official Node executable SHA256 mismatch');
const target = path.join(root, 'runtime', 'node', 'node.exe');
await mkdir(path.dirname(target), { recursive: true });
try { await copyFile(process.execPath, target, constants.COPYFILE_EXCL); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
if (digest(await readFile(target)) !== expected) throw new Error('Existing project Node executable differs; no overwrite performed');
console.log(JSON.stringify({ version: process.version, executable: target, sha256: expected, verified: true }));

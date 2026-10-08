// Local installation repair: upstream bdcf3bec references this runner but omits it.
// Keep the upstream npm commands intact and execute them with the required Node.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== manifest.engines.node) {
  throw new Error(`AIFISHER requires Windows x64 and Node.js ${manifest.engines.node}`);
}
const args = process.argv.slice(2);
if (args[0] === '--check') {
  console.log(JSON.stringify({ node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch }));
} else {
  if (args[0] === '--npm') {
    args.splice(0, 1, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  if (args.length === 0) throw new Error('A script or --check is required');
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code ?? 1; });
}

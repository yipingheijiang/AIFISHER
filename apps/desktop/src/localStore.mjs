import crypto from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Local state is flushed to a temporary file, then renamed atomically on Windows.
export async function writeFileAtomically(filePath, contents) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

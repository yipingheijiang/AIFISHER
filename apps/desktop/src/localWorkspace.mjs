import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { writeFileAtomically } from './localStore.mjs';

const isCanonicalUuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';

export async function chooseLocalWorkspace({ usersDirectory, choose, forceChoice = false }) {
  let entries;
  try { entries = await readdir(usersDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return randomUUID(); throw error; }
  const ids = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && isCanonicalUuid(entry.name))
    .map(entry => entry.name).sort();
  if (!ids.length) return randomUUID();
  if (ids.length === 1 && !forceChoice) return ids[0];
  const selected = await choose(ids);
  if (selected === 'new') return randomUUID();
  if (!ids.includes(selected)) throw new Error('尚未选择本机工作区；原项目仍保留。');
  return selected;
}

// Only the workspace UUID is migrated. Device secrets/cloud tokens are never copied or used.
export function createLocalWorkspace({ filePath, legacyDevicePath, decryptString, resolveLocalUser }) {
  let userId = null;
  let loading;
  const save = async (id) => {
    if (!isCanonicalUuid(id) || id === '00000000-0000-0000-0000-000000000000') throw new Error('工作区标识无效');
    await writeFileAtomically(filePath, JSON.stringify({ version: 1, workspaceId: id }));
    userId = id;
  };
  async function initialize() {
    try {
      const record = JSON.parse(await readFile(filePath, 'utf8'));
      if (record.version !== 1 || !isCanonicalUuid(record.workspaceId)) throw new Error('本机工作区记录损坏');
      userId = record.workspaceId;
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let legacyId;
    try {
      const bytes = await readFile(legacyDevicePath);
      if (bytes.length > 16384 || bytes.subarray(0, 9).toString() !== 'AFDEVICE1') throw new Error('原工作区记录损坏，请保留备份');
      legacyId = JSON.parse(await decryptString(bytes.subarray(9))).localUserId;
      if (!isCanonicalUuid(legacyId)) throw new Error('原工作区标识无效');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await save(legacyId || await resolveLocalUser());
  }
  const restore = async () => {
    await (loading ??= initialize().catch(error => { loading = null; throw error; }));
    return { state: 'ready', message: '本机工作区已就绪。' };
  };
  return { restore, userId: () => userId, async selectLocalUser(id) { await restore(); await save(id); } };
}

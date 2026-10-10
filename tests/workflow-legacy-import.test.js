import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SQLiteWorkflowStore } from '../server/workflow/sqliteWorkflowStore.js';

const directories = [], stores = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aifisher-legacy-import-'));
  directories.push(directory);
  await mkdir(path.join(directory, 'media'));
  const open = () => {
    const store = new SQLiteWorkflowStore({ dbPath: path.join(directory, 'workflows.db'), libraryDir: directory });
    stores.push(store); return store;
  };
  const project = { id: 'legacy-project', title: 'Legacy project', nodes: [{ id: 'node1', type: 'Text', text: 'source' }], groups: [] };
  const snapshot = path.join(directory, 'media', `${project.id}.json`);
  const writeLegacy = () => writeFile(snapshot, JSON.stringify(project));
  return { directory, open, project, snapshot, writeLegacy };
}

describe('one-time legacy JSON import', () => {
  it('imports projects and folders on the first initialization of a new database', async () => {
    const f = await fixture(); await f.writeLegacy();
    await writeFile(path.join(f.directory, 'folders.json'), JSON.stringify([{ id: 'folder1', name: 'Legacy folder' }]));
    const store = f.open(); await store.init();
    expect((await store.getWorkflowById(f.project.id)).nodes).toEqual(f.project.nodes);
    expect((await store.listFolders()).map(folder => folder.id)).toEqual(['folder1']);
  });

  it('keeps all projects and folders deleted after reopening, while leaving legacy files intact', async () => {
    const f = await fixture(); await f.writeLegacy();
    await writeFile(path.join(f.directory, 'folders.json'), JSON.stringify([{ id: 'folder1', name: 'Legacy folder' }]));
    const store = f.open(); await store.init();
    await store.deleteWorkflow(f.project.id); await store.run('DELETE FROM folders'); await store.close();
    const reopened = f.open(); await reopened.init();
    expect(await reopened.listWorkflows()).toEqual([]);
    expect(await reopened.listFolders()).toEqual([]);
    expect(JSON.parse(await readFile(f.snapshot, 'utf8'))).toEqual(f.project);
  });

  it('preserves an established v4 empty database instead of reviving residual snapshots on upgrade', async () => {
    const f = await fixture(), old = f.open(); await old.init();
    await old.run('DROP TABLE IF EXISTS workflow_store_migrations'); await old.run('PRAGMA user_version = 4'); await old.close();
    await f.writeLegacy();
    await writeFile(path.join(f.directory, 'folders.json'), JSON.stringify([{ id: 'deleted-folder', name: 'Deleted' }]));
    const upgraded = f.open(); await upgraded.init();
    expect(await upgraded.listWorkflows()).toEqual([]);
    expect(await upgraded.listFolders()).toEqual([]);
  });

  it('does not import snapshots introduced after a new database already initialized empty', async () => {
    const f = await fixture(), store = f.open(); await store.init(); await store.close();
    await f.writeLegacy(); const reopened = f.open(); await reopened.init();
    expect(await reopened.listWorkflows()).toEqual([]);
  });

  it('rolls back a partial first import and retries both valid projects after a storage failure', async () => {
    const f = await fixture(); await f.writeLegacy();
    await writeFile(path.join(f.directory, 'media', 'second.json'), JSON.stringify({ ...f.project, id: 'second' }));
    const store = f.open(), save = store.saveWorkflow.bind(store); let attempts = 0;
    store.saveWorkflow = (...args) => {
      if (++attempts === 2) throw new Error('Injected storage failure');
      return save(...args);
    };
    await expect(store.init()).rejects.toThrow('Injected storage failure');
    expect(await store.get('SELECT count(*) AS count FROM workflows')).toEqual({ count: 0 });
    expect(await store.get('SELECT count(*) AS count FROM workflow_store_migrations')).toEqual({ count: 0 });
    await store.close(); const reopened = f.open(); await reopened.init();
    expect((await reopened.listWorkflows()).map(project => project.id).sort()).toEqual(['legacy-project', 'second']);
  });

  it('does not misidentify a partially initialized new database as an established v4 database', async () => {
    const f = await fixture(); await f.writeLegacy();
    const store = f.open(), migrate = store.applySchemaMigration.bind(store);
    store.applySchemaMigration = (version, options) => {
      if (version === 5) throw new Error('Injected schema failure');
      return migrate(version, options);
    };
    await expect(store.init()).rejects.toThrow('Injected schema failure');
    expect(await store.get('PRAGMA user_version')).toEqual({ user_version: 0 });
    await store.close(); const reopened = f.open(); await reopened.init();
    expect((await reopened.listWorkflows()).map(project => project.id)).toEqual(['legacy-project']);
  });
});

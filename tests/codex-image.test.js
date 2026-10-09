import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import express from 'express';
import http from 'node:http';
import { createCodexImageService } from '../server/agent/codex/codexImageService.js';
import { createGenerationCoordinator } from '../server/generation/generationCoordinator.js';
import { GenerationTaskJournal } from '../server/generation/generationTaskJournal.js';
import { createGenerationRouter } from '../server/routes/generation.js';
import { buildModelAvailability } from '../server/generation/modelAvailability.js';
import { codexEnvironment } from '../server/agent/codex/codexProcess.js';
import { saveMediaBufferToFile } from '../server/utils/imageHelpers.js';

vi.mock('../server/utils/imageHelpers.js', async original => ({ ...await original(), saveMediaBufferToFile: vi.fn(() => ({ url: '/library/test/native.png' })) }));

async function setup(mode = 'success') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aifisher-codex-image-'));
  const library = path.join(directory, 'library'); await mkdir(library);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0088ff' } }).png().toBuffer();
  const events = new EventEmitter(), calls = [];
  let item, threadId = 'native-thread', currentMode = mode;
  const rpc = { events, start: async () => {}, close: () => {}, reject: vi.fn(),
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'test@example.invalid' } };
      if (method === 'model/list') return { data: [{ model: 'native-agent', isDefault: true }] };
      if (method === 'thread/start') return { thread: { id: threadId } };
      if (method === 'turn/start') {
        item = { type: 'imageGeneration', id: 'image-1', status: currentMode === 'usage' ? 'failed' : 'completed',
          result: currentMode === 'invalid' ? 'not-image' : png.toString('base64'),
          ...(currentMode === 'usage' ? { failure: { type: 'usageLimitExceeded', limitId: 'codex' } } : {}) };
        setTimeout(() => currentMode === 'disconnect' ? events.emit('disconnected', Object.assign(Error('Disconnected'), { code: 'CODEX_DISCONNECTED' }))
          : currentMode !== 'wait' && events.emit('notification', { method: 'item/completed', params: { threadId, turnId: 'native-turn', item } }), 5);
        return { turn: { id: 'native-turn' } };
      }
      if (method === 'thread/read') return { thread: { id: threadId, turns: [{ id: 'native-turn', status: 'completed', items: [item] }] } };
      return {};
    },
  };
  const service = createCodexImageService({ privateDirectory: path.join(directory, 'private'), libraryDirectory: library, rpc });
  const request = { imageModel: 'Codex 内置生图', prompt: 'A blue fish', projectId: 'test-project', nodeId: 'test-node', generationAttemptId: 'test-attempt', imageMode: 'text-to-image', generateCount: 1 };
  return { service, request, rpc, calls, png, directory, library, setMode: value => { currentMode = value; }, close: async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

async function server(service, run) {
  const coordinator = createGenerationCoordinator();
  const app = express(); app.use(express.json()); app.locals.CODEX_IMAGES = service;
  app.use('/api', createGenerationRouter({ generationCoordinator: coordinator }));
  const listener = http.createServer(app); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${listener.address().port}`, coordinator); }
  finally { coordinator.dispose(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
}
const submit = async (base, body) => fetch(base + '/api/generate-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('native Codex image integration', () => {
  it('routes a native image into media storage and task state, without any API key', async () => {
    const x = await setup();
    try { await server(x.service, async (base, coordinator) => {
      const response = await submit(base, x.request);
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ resultUrl: '/library/test/native.png' });
      const task = coordinator.getTask(x.request.nodeId);
      expect(task.status).toBe('success'); expect(task.remoteTasks[0].version).toBe(2);
      expect(saveMediaBufferToFile.mock.calls.at(-1)[4]).toMatchObject({ cost: null, costStatus: 'codex-usage' });
      expect(x.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
      expect(x.calls.some(call => call.method === 'turn/interrupt')).toBe(true);
      await expect(x.service.generate(x.request, {})).rejects.toMatchObject({ submissionUncertain: true });
      expect(x.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
    }); } finally { await x.close(); }
  });
  it('recovers an interrupted native task by reading its original thread, without resubmitting', async () => {
    const x = await setup('disconnect');
    try { await server(x.service, async (base, coordinator) => {
      expect((await submit(base, x.request)).status).toBe(503);
      expect(coordinator.getTask(x.request.nodeId).status).toBe('unknown');
      x.setMode('success');
      const result = await (await fetch(base + '/api/generation-status/test-node?attemptId=test-attempt')).json();
      expect(result.status).toBe('success'); expect(result.resultUrls).toEqual(['/library/test/native.png']);
      expect(x.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
      expect(x.calls.some(call => call.method === 'thread/read')).toBe(true);
    }); } finally { await x.close(); }
  });
  it('preserves a native quota failure and does not automatically retry', async () => {
    const x = await setup('usage');
    try { await server(x.service, async base => {
      const response = await submit(base, x.request);
      expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ code: 'CODEX_IMAGE_USAGE_LIMIT', retryable: false });
      expect(x.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
    }); } finally { await x.close(); }
  });
  it('rejects remote/traversal references and multi-image requests before generation', async () => {
    const x = await setup();
    try {
      await writeFile(path.join(x.directory, 'private.png'), x.png);
      for (const ref of ['https://example.invalid/image.png', '/library/../private.png'])
        await expect(x.service.generate({ ...x.request, imageBase64: [ref] }, {})).rejects.toMatchObject({ code: 'CODEX_IMAGE_REFERENCE_REJECTED' });
      await expect(x.service.generate({ ...x.request, generateCount: 2 }, {})).rejects.toMatchObject({ code: 'CODEX_IMAGE_INVALID_REQUEST' });
      expect(x.calls.some(call => call.method === 'turn/start')).toBe(false);
    } finally { await x.close(); }
  });
  it('copies validated local reference images and stops cancelled tasks without accepting late results', async () => {
    const x = await setup('wait');
    try {
      await writeFile(path.join(x.library, 'reference.png'), x.png);
      const controller = new AbortController();
      const result = x.service.generate({ ...x.request, imageBase64: ['/library/reference.png'], signal: controller.signal }, {});
      const verdict = expect(result).rejects.toMatchObject({ code: 'GENERATION_CANCELLED' });
      await vi.waitFor(() => expect(x.calls.some(call => call.method === 'turn/start')).toBe(true));
      const input = x.calls.find(call => call.method === 'turn/start').params.input;
      expect(input[1].type).toBe('localImage'); expect(input[1].path).toContain('reference-0.png');
      controller.abort(); await verdict;
      expect(x.calls.some(call => call.method === 'turn/interrupt')).toBe(true);
    } finally { await x.close(); }
  });
  it('does not report disconnected Codex as configured and strips API credentials from its process', () => {
    const model = { name: 'Codex 内置生图', canonicalModel: 'Codex 内置生图', provider: 'CodexImageProvider', source: 'codex', endpoint: { 'text-to-image': { url: 'codex://image', model: 'native' } } };
    expect(buildModelAvailability({ catalog: { native: model }, readSecret: () => '', providerConfiguration: {} })[0].available).toBe(false);
    const env = codexEnvironment('private-codex-home', { PATH: '/bin', OPENAI_API_KEY: 'never-forward', CODEX_HOME: 'global-home', AMT5_API_KEY: 'never-forward' });
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: 'private-codex-home' });
  });
  it('keeps an already-submitted cancellation unknown and refuses a new attempt until reconciled', async () => {
    const x = await setup('wait');
    try { await server(x.service, async (base, coordinator) => {
      const submitted = submit(base, x.request);
      await vi.waitFor(() => expect(x.calls.some(call => call.method === 'turn/start')).toBe(true));
      const cancel = await fetch(base + '/api/generation-cancel/test-node', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'test-project', attemptId: 'test-attempt' }) });
      expect(await cancel.json()).toMatchObject({ status: 'unknown', retryable: false, remoteMayContinue: true });
      expect((await submitted).status).toBe(503);
      const duplicate = await submit(base, { ...x.request, generationAttemptId: 'other-attempt' });
      expect(duplicate.status).toBe(409); expect(coordinator.getTask('test-node').status).toBe('unknown');
      expect(x.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
      const recovered = await (await fetch(base + '/api/generation-status/test-node?attemptId=test-attempt')).json();
      expect(recovered.status).toBe('success');
    }); } finally { await x.close(); }
  });
  it('confirms cancellation before submission and a restart from prepared without sending a turn', async () => {
    const x = await setup();
    try {
      const controller = new AbortController(); let reference;
      await expect(x.service.generate({ ...x.request, signal: controller.signal }, {
        generationTaskSubmitted: value => { reference = value; controller.abort(); },
      })).rejects.toMatchObject({ code: 'GENERATION_CANCELLED' });
      const task = { attemptId: x.request.generationAttemptId, projectId: x.request.projectId, nodeId: x.request.nodeId, remoteTasks: [reference] };
      expect(await x.service.recover(task)).toMatchObject({ status: 'failed', error: { code: 'CODEX_IMAGE_NOT_SUBMITTED' } });
      const records = path.join(x.directory, 'private/codex/image-jobs');
      const file = path.join(records, (await readdir(records))[0]);
      const record = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...record, phase: 'prepared' }));
      expect(await x.service.recover(task)).toMatchObject({ status: 'failed', error: { code: 'CODEX_IMAGE_NOT_SUBMITTED' } });
      expect(x.calls.some(call => call.method === 'turn/start')).toBe(false);
    } finally { await x.close(); }
  });
  it('locks concurrent starts before asynchronous account checks', async () => {
    const x = await setup('wait');
    try {
      const controller = new AbortController();
      const first = x.service.generate({ ...x.request, signal: controller.signal }, {});
      const stopped = expect(first).rejects.toMatchObject({ code: 'GENERATION_CANCELLED' });
      await expect(x.service.generate({ ...x.request, generationAttemptId: 'second' }, {})).rejects.toMatchObject({ code: 'CODEX_IMAGE_BUSY' });
      await vi.waitFor(() => expect(x.calls.some(call => call.method === 'turn/start')).toBe(true));
      controller.abort(); await stopped;
      expect(x.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
    } finally { await x.close(); }
  });
  it('unlocks a task interrupted before native submission after a journal restart', async () => {
    const x = await setup();
    let coordinator;
    try {
      const filePath = path.join(x.directory, 'generation-tasks.json');
      coordinator = createGenerationCoordinator({ taskStore: new GenerationTaskJournal({ filePath }) });
      expect(coordinator.begin({ nodeId: 'before-submit', attemptId: 'old', kind: 'image', modelIdKey: 'codex', metadata: { providerName: 'CodexImageProvider' } }).ok).toBe(true);
      coordinator.dispose();
      coordinator = createGenerationCoordinator({ taskStore: new GenerationTaskJournal({ filePath }) });
      expect(coordinator.getTask('before-submit')).toMatchObject({ status: 'failed', code: 'CODEX_IMAGE_NOT_SUBMITTED', remoteMayContinue: false });
      expect(coordinator.begin({ nodeId: 'before-submit', attemptId: 'new', kind: 'image', modelIdKey: 'codex', metadata: { providerName: 'CodexImageProvider' } }).ok).toBe(true);
      expect(x.calls.some(call => call.method === 'turn/start')).toBe(false);
    } finally { coordinator?.dispose(); await x.close(); }
  });
});

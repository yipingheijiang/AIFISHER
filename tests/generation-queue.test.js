import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { createGenerationCoordinator } from '../server/generation/generationCoordinator.js';
import { executeGenerationTask } from '../server/generation/generationExecution.js';
import { GenerationTaskJournal } from '../server/generation/generationTaskJournal.js';
import { createGenerationRecoveryRouter } from '../server/generation/generationRecoveryRouter.js';

function harness(options = {}) {
  const coordinator = createGenerationCoordinator(options);
  const calls = [], gates = new Map();
  const budgets = { reserve: vi.fn(async () => {}) };
  const provider = {
    maximumCharge: vi.fn(async () => ({ currency: 'CNY', guaranteed: true, micros: 100 })),
    generateImage: vi.fn(request => {
      calls.push(request.nodeId);
      return new Promise(resolve => gates.set(request.nodeId, resolve));
    }),
  };
  function submit(nodeId, modelIdKey = 'physical-a', maxConcurrent = 1, extra = {}) {
    return executeGenerationTask({ kind: 'image', nodeId, modelName: 'mock-model', providerName: 'MockImageProvider',
      executionContext: { modelIdKey, maxConcurrent, timeEstimate: '1min' },
      request: { nodeId, projectId: 'queue-project', generationAttemptId: `${nodeId}-attempt`, prompt: 'mock only',
        imageMode: 'text-to-image', generateCount: 1, agentAuthorizationId: 'mock-authorization', ...extra },
      appContext: { GENERATION_BUDGETS: budgets }, provider, coordinator,
      saveResult: async value => ({ resultUrl: `/library/${value}.png` }),
    }).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  }
  return { coordinator, calls, gates, budgets, provider, submit,
    finish(nodeId) { gates.get(nodeId)(nodeId); }, dispose() { coordinator.dispose(); } };
}

async function server(coordinator, run) {
  const app = express(); app.use(express.json());
  app.use('/api', createGenerationRecoveryRouter({ coordinator, getUrlPrefix: () => '' }));
  const listener = http.createServer(app);
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${listener.address().port}`); }
  finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
}

describe('generation admission queue', () => {
  it('runs FIFO through the actual execution chain without reserving a budget or lease while waiting', async () => {
    let clock = Date.now();
    const x = harness({ now: () => clock });
    try {
      const first = x.submit('first');
      await vi.waitFor(() => expect(x.calls).toEqual(['first']));
      const second = x.submit('second'), third = x.submit('third');
      expect(x.coordinator.getTask('second')).toMatchObject({ status: 'queued', phase: 'waiting-for-slot', queuePosition: 1, requestedCount: 1 });
      expect(x.coordinator.getTask('third').queuePosition).toBe(2);
      expect(x.coordinator.getTask('second').leaseId).toBeUndefined();
      expect(x.coordinator.getTask('second').absoluteDeadlineAt).toBeUndefined();
      expect(x.coordinator.getConcurrency('physical-a')).toMatchObject({ inFlight: 1, queued: 2, blocked: true });
      expect(x.budgets.reserve).toHaveBeenCalledTimes(1);
      expect(x.provider.maximumCharge).toHaveBeenCalledTimes(1);
      clock += 60 * 60_000; // Queue waiting time never consumes the execution timeout.
      x.finish('first'); expect((await first).ok).toBe(true);
      await vi.waitFor(() => expect(x.calls).toEqual(['first', 'second']));
      expect(x.coordinator.getTask('second')).toMatchObject({ status: 'loading', phase: 'loading', startedAt: new Date(clock).toISOString() });
      expect(Date.parse(x.coordinator.getTask('second').absoluteDeadlineAt)).toBeGreaterThan(clock);
      expect(x.coordinator.getTask('third').queuePosition).toBe(1);
      x.finish('second'); await second;
      await vi.waitFor(() => expect(x.calls).toEqual(['first', 'second', 'third']));
      x.finish('third'); expect((await third).ok).toBe(true);
      expect(x.coordinator.getConcurrency('physical-a')).toMatchObject({ inFlight: 0, queued: 0 });
      expect(x.budgets.reserve).toHaveBeenCalledTimes(3);
    } finally { x.dispose(); }
  });

  it('honors maxConcurrent and starts another physical model independently', async () => {
    const x = harness();
    try {
      const promises = [x.submit('a1', 'a', 2), x.submit('a2', 'a', 2), x.submit('a3', 'a', 2), x.submit('b1', 'b', 1)];
      await vi.waitFor(() => expect(x.calls).toEqual(['a1', 'a2', 'b1']));
      expect(x.coordinator.getConcurrency('a', 2)).toMatchObject({ inFlight: 2, queued: 1 });
      expect(x.coordinator.getConcurrency('b')).toMatchObject({ inFlight: 1, queued: 0 });
      x.finish('a2'); await promises[1];
      await vi.waitFor(() => expect(x.calls).toEqual(['a1', 'a2', 'b1', 'a3']));
      expect(x.coordinator.getConcurrency('a', 2).inFlight).toBe(2);
      for (const node of ['a1', 'a3', 'b1']) x.finish(node);
      expect((await Promise.all(promises)).every(result => result.ok)).toBe(true);
    } finally { x.dispose(); }
  });

  it('keeps FIFO when a new request arrives between lease release and the scheduling microtask', async () => {
    const coordinator = createGenerationCoordinator();
    try {
      const params = nodeId => ({ nodeId, attemptId: `${nodeId}-attempt`, modelIdKey: 'a', maxConcurrent: 1 });
      const first = await coordinator.acquire(params('first'));
      const second = coordinator.acquire(params('second'));
      coordinator.complete('first', {}, first.attemptId);
      expect(coordinator.begin(params('bypass')).code).toBe('MODEL_CONCURRENCY_LIMIT');
      const third = coordinator.acquire(params('third'));
      expect(coordinator.getTask('third')).toMatchObject({ status: 'queued', queuePosition: 2 });
      expect((await second).ok).toBe(true);
      expect(coordinator.getTask('second').status).toBe('loading');
      expect(coordinator.getTask('third').status).toBe('queued');
      coordinator.complete('second', {}, 'second-attempt');
      expect((await third).ok).toBe(true);
      expect(coordinator.getTask('third').status).toBe('loading');
    } finally { coordinator.dispose(); }
  });

  it('reports queued/loading phases and cancels only the bound queued attempt before a provider starts', async () => {
    const x = harness();
    try {
      const first = x.submit('first');
      await vi.waitFor(() => expect(x.calls).toEqual(['first']));
      const second = x.submit('second'), third = x.submit('third');
      await server(x.coordinator, async base => {
        const status = node => fetch(`${base}/api/generation-status/${node}?attemptId=${node}-attempt`).then(response => response.json());
        expect(await status('second')).toMatchObject({ status: 'pending', phase: 'queued', queuePosition: 1, attemptId: 'second-attempt' });
        expect(await status('first')).toMatchObject({ status: 'pending', phase: 'loading', startedAt: expect.any(String) });
        const cancel = (node, attemptId = `${node}-attempt`) => fetch(`${base}/api/generation-cancel/${node}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'queue-project', attemptId, onlyQueued: true }),
        });
        expect((await cancel('second', 'stale-attempt')).status).toBe(409);
        expect(x.coordinator.getTask('second').status).toBe('queued');
        const cancelled = await cancel('second');
        expect(await cancelled.json()).toMatchObject({ status: 'cancelled', code: 'GENERATION_CANCELLED', retryable: false, remoteMayContinue: false });
        expect(await second).toMatchObject({ ok: false, error: { code: 'GENERATION_CANCELLED', status: 499, retryable: false } });
        expect(x.coordinator.getTask('third').queuePosition).toBe(1);
        x.finish('first'); await first;
        await vi.waitFor(() => expect(x.calls).toEqual(['first', 'third']));
        const afterStart = await cancel('third');
        expect(afterStart.status).toBe(409);
        expect(await afterStart.json()).toMatchObject({ code: 'GENERATION_NOT_QUEUED' });
        expect(x.coordinator.getTask('third').status).toBe('loading');
        x.finish('third'); expect((await third).ok).toBe(true);
      });
      expect(x.provider.generateImage).toHaveBeenCalledTimes(2);
    } finally { x.dispose(); }
  });

  it('refuses duplicate active nodes and unresolved native attempts without disturbing FIFO', async () => {
    const x = harness();
    try {
      const first = x.submit('first');
      await vi.waitFor(() => expect(x.calls).toEqual(['first']));
      const queued = x.submit('queued');
      const duplicate = await x.submit('queued', 'other-model', 5, { generationAttemptId: 'another-attempt' });
      expect(duplicate).toMatchObject({ ok: false, error: { code: 'NODE_GENERATION_ACTIVE', status: 409 } });
      expect(x.coordinator.getTask('queued')).toMatchObject({ attemptId: 'queued-attempt', queuePosition: 1 });
      expect(x.coordinator.begin({ nodeId: 'native', attemptId: 'old-native', modelIdKey: 'native', metadata: { providerName: 'CodexImageProvider' } }).ok).toBe(true);
      x.coordinator.finalizeUnknown('native', {}, 'old-native');
      expect(await x.coordinator.acquire({ nodeId: 'native', attemptId: 'new-native', modelIdKey: 'physical-a' }))
        .toMatchObject({ ok: false, code: 'NODE_GENERATION_UNCONFIRMED', status: 409, retryable: false });
      expect(x.coordinator.getConcurrency('physical-a').queued).toBe(1);
      x.finish('first'); await first;
      await vi.waitFor(() => expect(x.calls).toEqual(['first', 'queued']));
      x.finish('queued'); expect((await queued).ok).toBe(true);
    } finally { x.dispose(); }
  });

  it('terminates unsubmitted waiters on restart without replaying ambiguous or remote tasks', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aifisher-queue-journal-'));
    const filePath = path.join(directory, 'tasks.json');
    const x = harness({ taskStore: new GenerationTaskJournal({ filePath }) });
    try {
      const first = x.submit('first');
      await vi.waitFor(() => expect(x.calls).toEqual(['first']));
      const waiting = x.submit('waiting');
      const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
      snapshot.tasks.push({ nodeId: 'native-waiting', status: 'queued', phase: 'waiting-for-slot', providerName: 'CodexImageProvider' });
      snapshot.tasks.push({ nodeId: 'ambiguous', status: 'queued', phase: 'submitting', remoteSubmissionStarted: true });
      await writeFile(filePath, JSON.stringify(snapshot));
      const recovered = new GenerationTaskJournal({ filePath });
      for (const node of ['waiting', 'native-waiting']) expect(recovered.get(node))
        .toMatchObject({ status: 'failed', code: 'GENERATION_NOT_SUBMITTED', retryable: false, remoteMayContinue: false });
      expect(recovered.get('ambiguous')).toMatchObject({ status: 'unknown', code: 'GENERATION_INTERRUPTED', retryable: false });
      expect(recovered.get('first').status).toBe('unknown');
      x.dispose();
      expect(await waiting).toMatchObject({ ok: false, error: { code: 'GENERATION_NOT_SUBMITTED' } });
      x.finish('first'); await first;
      expect(x.calls).toEqual(['first']);
    } finally { x.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('does not execute or reserve a waiting task when its journal write fails', async () => {
    const records = new Map();
    const x = harness({ taskStore: {
      upsert(task) { if (task.status === 'queued') throw Error('mock disk full'); records.set(task.nodeId, task); },
      get(nodeId) { return records.get(nodeId); },
    } });
    try {
      const first = x.submit('first');
      await vi.waitFor(() => expect(x.calls).toEqual(['first']));
      expect(await x.submit('waiting')).toMatchObject({ ok: false, error: { code: 'GENERATION_QUEUE_UNAVAILABLE', retryable: false } });
      expect(x.coordinator.getTask('waiting')).toMatchObject({ status: 'failed', remoteMayContinue: false });
      expect(x.coordinator.getConcurrency('physical-a').queued).toBe(0);
      expect(x.budgets.reserve).toHaveBeenCalledTimes(1);
      x.finish('first'); await first;
      expect(x.calls).toEqual(['first']);
    } finally { x.dispose(); }
  });

  it('does not call a provider if persisting the transition from queued to loading fails', async () => {
    const records = new Map();
    const x = harness({ taskStore: {
      upsert(task) { if (task.nodeId === 'waiting' && task.status === 'loading') throw Error('mock loading write failure'); records.set(task.nodeId, task); },
      get(nodeId) { return records.get(nodeId); },
    } });
    try {
      const first = x.submit('first');
      await vi.waitFor(() => expect(x.calls).toEqual(['first']));
      const waiting = x.submit('waiting');
      expect(x.coordinator.getTask('waiting').status).toBe('queued');
      x.finish('first'); await first;
      expect(await waiting).toMatchObject({ ok: false, error: { code: 'GENERATION_QUEUE_UNAVAILABLE', retryable: false } });
      expect(x.coordinator.getConcurrency('physical-a')).toMatchObject({ inFlight: 0, queued: 0 });
      expect(x.budgets.reserve).toHaveBeenCalledTimes(1);
      expect(x.calls).toEqual(['first']);
    } finally { x.dispose(); }
  });
});

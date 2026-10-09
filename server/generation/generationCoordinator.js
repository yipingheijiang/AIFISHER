import crypto from 'node:crypto';
import { canRecoverGenerationTask, isRecoverableProvider, sanitizeRemoteTaskReference } from './generationTaskRecovery.js';

const TERMINAL_STATUSES = new Set(['success', 'failed', 'cancelled', 'unknown']);

function cloneTask(task) {
  return task ? { ...task } : null;
}

function normalizeLimit(value) {
  if (value === 0) return 0; // Explicitly unlimited local admission; provider limits still apply.
  return Math.max(1, Number(value) || 1);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createSchedulerCommitProof({ runId, receiptPayloadHash, finishedAt }) {
  const payload = {
    runId,
    status: 'success',
    receiptPayloadHash,
    finishedAt,
  };
  return {
    ...payload,
    commitHash: sha256(JSON.stringify(payload)),
  };
}

export function createGenerationCoordinator({
  parseTimeToMs = () => 15 * 60 * 1_000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  minimumLeaseTtlMs = 180_000,
  leaseSafetyMarginMs = 120_000,
  taskStore = null,
} = {}) {
  const inFlightByModelId = new Map();
  const leases = new Map();
  const tasks = new Map();
  const controllers = new Map();
  const waitingByModelId = new Map();
  const waitingByNodeId = new Map();
  const scheduledModels = new Set();
  let leaseSeed = 0;
  let queueSeed = 0;
  let disposed = false;

  function persist(task) {
    taskStore?.upsert?.(cloneTask(task));
  }

  function getConcurrency(modelIdKey, maxConcurrent = 1) {
    const limit = normalizeLimit(maxConcurrent);
    const inFlight = Number(inFlightByModelId.get(modelIdKey) || 0);
    return {
      inFlight,
      maxConcurrent: limit,
      available: limit === 0 ? null : Math.max(0, limit - inFlight),
      blocked: limit > 0 && inFlight >= limit,
      queued: waitingByModelId.get(modelIdKey)?.length || 0,
    };
  }

  function admissionFailure(code, message, status = 503) {
    return { ok: false, code, message, status, retryable: false };
  }

  function failWaiting(modelIdKey) {
    const queue = waitingByModelId.get(modelIdKey) || [];
    waitingByModelId.delete(modelIdKey);
    const failure = admissionFailure('GENERATION_QUEUE_UNAVAILABLE', '无法保存排队状态，任务未提交，请检查本机存储后重试。');
    for (const entry of queue) {
      waitingByNodeId.delete(entry.nodeId);
      const task = tasks.get(entry.nodeId);
      if (task?.attemptId === entry.attemptId && task.status === 'queued') {
        Object.assign(task, { status: 'failed', phase: 'not-submitted', code: failure.code,
          diagnosticCode: failure.code, error: failure.message, retryable: false, remoteMayContinue: false,
          queuePosition: undefined, updatedAt: new Date(now()).toISOString(), finishedAt: new Date(now()).toISOString() });
        try { persist(task); } catch { /* Never execute a waiter whose durable state is unavailable. */ }
      }
      entry.resolve(failure);
    }
  }

  function updateQueuePositions(modelIdKey) {
    const queue = waitingByModelId.get(modelIdKey) || [];
    for (let index = 0; index < queue.length; index += 1) {
      const task = tasks.get(queue[index].nodeId);
      if (task?.attemptId !== queue[index].attemptId || task.status !== 'queued') continue;
      if (task.queuePosition === index + 1) continue;
      Object.assign(task, { queuePosition: index + 1, updatedAt: new Date(now()).toISOString() });
      persist(task);
    }
  }

  function scheduleDrain(modelIdKey) {
    if (disposed || scheduledModels.has(modelIdKey)) return;
    scheduledModels.add(modelIdKey);
    // A terminal transition must finish persisting before another provider can start.
    queueMicrotask(() => {
      scheduledModels.delete(modelIdKey);
      if (disposed) return;
      const queue = waitingByModelId.get(modelIdKey);
      if (!queue) return;
      while (queue.length && !getConcurrency(modelIdKey, queue[0].params.maxConcurrent).blocked) {
        const entry = queue.shift();
        waitingByNodeId.delete(entry.nodeId);
        const task = tasks.get(entry.nodeId);
        if (task?.attemptId !== entry.attemptId || task.status !== 'queued') {
          entry.resolve(admissionFailure('GENERATION_CANCELLED', '排队任务已停止，没有提交生成。', 499));
          continue;
        }
        entry.resolve(begin(entry.params, { queuedTask: task }));
      }
      if (!queue.length) waitingByModelId.delete(modelIdKey);
      try { updateQueuePositions(modelIdKey); } catch { failWaiting(modelIdKey); }
    });
  }

  function release(leaseId) {
    if (!leaseId) return false;
    const lease = leases.get(leaseId);
    if (!lease || lease.released) return false;

    lease.released = true;
    clearTimer(lease.timer);
    const current = Number(inFlightByModelId.get(lease.modelIdKey) || 0);
    const next = Math.max(0, current - 1);
    if (next === 0) inFlightByModelId.delete(lease.modelIdKey);
    else inFlightByModelId.set(lease.modelIdKey, next);
    leases.delete(leaseId);
    scheduleDrain(lease.modelIdKey);
    return true;
  }

  function transition(nodeId, status, details = {}, timestampMs = now(), expectedAttemptId) {
    const task = tasks.get(nodeId);
    if (
      !task
      || TERMINAL_STATUSES.has(task.status)
      || (expectedAttemptId && task.attemptId !== expectedAttemptId)
    ) return false;

    Object.assign(task, details, {
      status,
      updatedAt: new Date(timestampMs).toISOString(),
    });
    if (TERMINAL_STATUSES.has(status)) {
      task.finishedAt = task.updatedAt;
      const startedAtMs = Date.parse(task.createdAt);
      task.durationMs = Number.isFinite(startedAtMs) ? Math.max(0, timestampMs - startedAtMs) : 0;
      task.diagnosticCode =
        details.code ||
        (status === 'success'
          ? 'GENERATION_SUCCEEDED'
          : status === 'cancelled'
            ? 'GENERATION_CANCELLED'
            : status === 'unknown'
              ? 'WORKFLOW_RUN_UNKNOWN'
              : 'GENERATION_FAILED');
      release(task.leaseId);
      controllers.delete(nodeId);
    }
    persist(task);
    return cloneTask(task);
  }

  function expire(leaseId) {
    const lease = leases.get(leaseId);
    if (!lease) return;
    const task = tasks.get(lease.nodeId);
    if (task && !TERMINAL_STATUSES.has(task.status)) {
      if (task.remoteTask || task.remoteSubmissionStarted) {
        controllers.get(task.nodeId)?.abort();
        finalizeUnknown(task.nodeId, {
          code: task.remoteTask ? 'GENERATION_OBSERVATION_INTERRUPTED' : 'GENERATION_SUBMISSION_UNKNOWN',
          error: '原任务仍可能在服务商运行，请先核对任务记录，避免重复生成。',
        }, task.attemptId);
        return;
      }
      transition(lease.nodeId, 'failed', {
        code: 'GENERATION_LEASE_EXPIRED',
        error: '生成任务超过最长执行时间，可重试。',
        retryable: true,
      });
      return;
    }
    release(leaseId);
  }

  function begin({
    nodeId,
    attemptId,
    kind,
    modelName,
    modelIdKey,
    maxConcurrent = 1,
    timeEstimate = '5min',
    generateCount = 1,
    metadata = {},
    leaseHeartbeatMs,
    absoluteTimeoutMs,
  }, { queuedTask } = {}) {
    if (disposed) return admissionFailure('GENERATION_SERVICE_STOPPED', '生成服务已停止，任务未提交。');
    const taskId = String(nodeId || `generation-${now()}-${leaseSeed + 1}`);
    const concurrency = getConcurrency(modelIdKey, maxConcurrent);
    const previous = getTask(taskId);
    if (previous?.providerName === 'CodexImageProvider' && previous.status === 'unknown') {
      return { ok: false, code: 'NODE_GENERATION_UNCONFIRMED', status: 409, retryable: false,
        message: '原 Codex 生图结果尚未确认，请先核对原任务，避免重复生成。' };
    }
    if (tasks.get(taskId)?.status === 'loading' || (tasks.get(taskId)?.status === 'queued' && tasks.get(taskId) !== queuedTask)) {
      return {
        ok: false,
        code: 'NODE_GENERATION_ACTIVE',
        inFlight: concurrency.inFlight,
        maxConcurrent: concurrency.maxConcurrent,
      };
    }
    if (concurrency.blocked || (!queuedTask && concurrency.queued > 0)) {
      return {
        ok: false,
        code: 'MODEL_CONCURRENCY_LIMIT',
        inFlight: concurrency.inFlight,
        maxConcurrent: concurrency.maxConcurrent,
      };
    }

    const inFlight = concurrency.inFlight + 1;
    inFlightByModelId.set(modelIdKey, inFlight);
    const leaseId = `lease_${now()}_${++leaseSeed}_${taskId}`;
    const estimatedMs = Math.max(0, Number(parseTimeToMs(timeEstimate)) || 0);
    const ttlMs = Math.max(
      minimumLeaseTtlMs,
      estimatedMs * Math.max(1, Number(generateCount) || 1) + leaseSafetyMarginMs,
    );
    const heartbeatMs = Number.isFinite(Number(leaseHeartbeatMs))
      ? Math.max(1_000, Number(leaseHeartbeatMs))
      : ttlMs;
    const absoluteTtlMs = Number.isFinite(Number(absoluteTimeoutMs))
      ? Math.max(ttlMs, Number(absoluteTimeoutMs))
      : ttlMs;
    const controller = new AbortController();
    const startedAtMs = now();
    const timestamp = new Date(startedAtMs).toISOString();
    const task = {
      nodeId: taskId,
      attemptId: String(attemptId || crypto.randomUUID()),
      kind,
      modelName,
      modelIdKey,
      maxConcurrent: concurrency.maxConcurrent,
      leaseId,
      status: 'loading',
      retryable: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      absoluteDeadlineAt: new Date(startedAtMs + absoluteTtlMs).toISOString(),
      ...metadata,
      phase: metadata.phase || 'loading',
      startedAt: timestamp,
      ...(queuedTask ? { queuedAt: queuedTask.queuedAt } : {}),
    };
    const timer = setTimer(() => expire(leaseId), Math.min(heartbeatMs, absoluteTtlMs));

    leases.set(leaseId, {
      leaseId,
      attemptId: task.attemptId,
      nodeId: taskId,
      modelIdKey,
      timer,
      released: false,
      heartbeatMs,
      absoluteDeadlineMs: startedAtMs + absoluteTtlMs,
    });
    tasks.set(taskId, task);
    controllers.set(taskId, controller);
    try { persist(task); } catch {
      release(leaseId);
      controllers.delete(taskId);
      Object.assign(task, { status: 'failed', phase: 'not-submitted', code: 'GENERATION_QUEUE_UNAVAILABLE',
        retryable: false, remoteMayContinue: false, finishedAt: timestamp });
      try { persist(task); } catch { /* The provider has not been called. */ }
      return admissionFailure('GENERATION_QUEUE_UNAVAILABLE', '无法保存生成状态，任务未提交，请检查本机存储后重试。');
    }

    return {
      ok: true,
      leaseId,
      attemptId: task.attemptId,
      nodeId: taskId,
      signal: controller.signal,
      inFlight,
      maxConcurrent: concurrency.maxConcurrent,
      ttlMs,
      absoluteTtlMs,
    };
  }

  async function acquire(params) {
    if (disposed) return admissionFailure('GENERATION_SERVICE_STOPPED', '生成服务已停止，任务未提交。');
    const nodeId = String(params.nodeId || `generation-${now()}-queued-${++queueSeed}`);
    const attemptId = String(params.attemptId || crypto.randomUUID());
    const previous = getTask(nodeId);
    if (previous?.providerName === 'CodexImageProvider' && previous.status === 'unknown') {
      return admissionFailure('NODE_GENERATION_UNCONFIRMED', '原 Codex 生图结果尚未确认，请先核对原任务，避免重复生成。', 409);
    }
    const concurrency = getConcurrency(params.modelIdKey, params.maxConcurrent);
    if (['loading', 'queued'].includes(tasks.get(nodeId)?.status)) {
      return { ...admissionFailure('NODE_GENERATION_ACTIVE', '该节点已有生成或排队任务。', 409), ...concurrency };
    }
    const normalized = { ...params, nodeId, attemptId, maxConcurrent: concurrency.maxConcurrent };
    if (!concurrency.blocked && concurrency.queued === 0) return begin(normalized);
    return new Promise(resolve => {
      const queue = waitingByModelId.get(params.modelIdKey) || [];
      const timestamp = new Date(now()).toISOString();
      const task = { ...params.metadata, nodeId, attemptId, kind: params.kind,
        modelName: params.modelName, modelIdKey: params.modelIdKey, maxConcurrent: concurrency.maxConcurrent,
        status: 'queued', phase: 'waiting-for-slot', queuePosition: queue.length + 1,
        queuedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, retryable: false, remoteMayContinue: false };
      const entry = { nodeId, attemptId, params: normalized, resolve };
      queue.push(entry);
      waitingByModelId.set(params.modelIdKey, queue);
      waitingByNodeId.set(nodeId, entry);
      tasks.set(nodeId, task);
      try { persist(task); } catch { failWaiting(params.modelIdKey); return; }
      scheduleDrain(params.modelIdKey);
    });
  }

  function adopt(taskRecord, {
    leaseHeartbeatMs = 30_000,
    absoluteDeadlineMs,
  } = {}) {
    const nodeId = String(taskRecord?.nodeId || '');
    if (!nodeId || taskRecord?.status !== 'loading' || TERMINAL_STATUSES.has(taskRecord?.status)) {
      return { ok: false, code: 'GENERATION_RECOVERY_NOT_ACTIVE' };
    }
    if (tasks.has(nodeId)) {
      const existing = tasks.get(nodeId);
      return {
        ok: true,
        nodeId,
        leaseId: existing.leaseId,
        signal: controllers.get(nodeId)?.signal,
        recovered: false,
      };
    }
    const modelIdKey = String(taskRecord.modelIdKey || 'comfy:recovered');
    const timestampMs = now();
    const persistedDeadline = Date.parse(taskRecord.absoluteDeadlineAt || '');
    const fallbackDeadline = timestampMs + Math.max(1_000, Number(absoluteDeadlineMs) || 30 * 60_000);
    const absoluteDeadline = Number.isFinite(persistedDeadline) ? persistedDeadline : fallbackDeadline;
    if (absoluteDeadline <= timestampMs) {
      const expired = {
        ...taskRecord,
        status: 'failed',
        phase: 'recovery-expired',
        code: 'WORKFLOW_RUN_TIMEOUT',
        diagnosticCode: 'WORKFLOW_RUN_TIMEOUT',
        error: '工作流测试在服务重启期间超过最长执行时间。',
        retryable: true,
        remoteMayContinue: Boolean(taskRecord.promptId),
        updatedAt: new Date(timestampMs).toISOString(),
        finishedAt: new Date(timestampMs).toISOString(),
      };
      tasks.set(nodeId, expired);
      persist(expired);
      return { ok: false, code: 'GENERATION_RECOVERY_EXPIRED', task: cloneTask(expired) };
    }
    const leaseId = `lease_${timestampMs}_${++leaseSeed}_${nodeId}`;
    const controller = new AbortController();
    const heartbeatMs = Math.max(1_000, Number(leaseHeartbeatMs) || 30_000);
    const task = {
      ...taskRecord,
      leaseId,
      phase: 'recovering',
      updatedAt: new Date(timestampMs).toISOString(),
      absoluteDeadlineAt: new Date(absoluteDeadline).toISOString(),
    };
    const timer = setTimer(
      () => expire(leaseId),
      Math.min(heartbeatMs, absoluteDeadline - timestampMs),
    );
    leases.set(leaseId, {
      leaseId,
      nodeId,
      modelIdKey,
      timer,
      released: false,
      heartbeatMs,
      absoluteDeadlineMs: absoluteDeadline,
    });
    tasks.set(nodeId, task);
    controllers.set(nodeId, controller);
    inFlightByModelId.set(modelIdKey, Number(inFlightByModelId.get(modelIdKey) || 0) + 1);
    persist(task);
    return {
      ok: true,
      nodeId,
      leaseId,
      signal: controller.signal,
      recovered: true,
      absoluteDeadlineMs: absoluteDeadline,
    };
  }

  function update(nodeId, details = {}, expectedAttemptId) {
    const task = tasks.get(nodeId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return false;
    return transition(nodeId, task.status, details, now(), expectedAttemptId);
  }

  function pauseObservation(nodeId, details = {}) {
    const task = tasks.get(nodeId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return false;
    const timestamp = new Date(now()).toISOString();
    release(task.leaseId);
    controllers.delete(nodeId);
    delete task.leaseId;
    Object.assign(task, details, {
      status: 'loading',
      phase: 'observation-paused',
      updatedAt: timestamp,
      observationPausedAt: details.observationPausedAt || timestamp,
    });
    persist(task);
    return cloneTask(task);
  }

  function reacquireObservation(nodeId, {
    leaseHeartbeatMs = 30_000,
    absoluteTimeoutMs = 30 * 60_000,
  } = {}) {
    const persisted = tasks.get(nodeId) || taskStore?.get?.(nodeId);
    if (!persisted || persisted.status !== 'loading' || persisted.phase !== 'observation-paused') {
      return { ok: false, code: 'WORKFLOW_OBSERVATION_NOT_PAUSED' };
    }
    if (!tasks.has(nodeId)) tasks.set(nodeId, { ...persisted });
    const task = tasks.get(nodeId);
    const concurrency = getConcurrency(task.modelIdKey, task.maxConcurrent ?? 1);
    if (concurrency.blocked) {
      return { ok: false, code: 'MODEL_CONCURRENCY_LIMIT' };
    }
    const timestampMs = now();
    const heartbeatMs = Math.max(1_000, Number(leaseHeartbeatMs) || 30_000);
    const absoluteTtlMs = Math.max(heartbeatMs, Number(absoluteTimeoutMs) || 30 * 60_000);
    const leaseId = `lease_${timestampMs}_${++leaseSeed}_${nodeId}`;
    const controller = new AbortController();
    const timer = setTimer(() => expire(leaseId), Math.min(heartbeatMs, absoluteTtlMs));
    leases.set(leaseId, {
      leaseId,
      nodeId,
      modelIdKey: task.modelIdKey,
      timer,
      released: false,
      heartbeatMs,
      absoluteDeadlineMs: timestampMs + absoluteTtlMs,
    });
    inFlightByModelId.set(task.modelIdKey, concurrency.inFlight + 1);
    controllers.set(nodeId, controller);
    Object.assign(task, {
      leaseId,
      phase: 'observation-resuming',
      code: undefined,
      error: undefined,
      retryable: false,
      updatedAt: new Date(timestampMs).toISOString(),
      observationResumedAt: new Date(timestampMs).toISOString(),
      absoluteDeadlineAt: new Date(timestampMs + absoluteTtlMs).toISOString(),
    });
    persist(task);
    return {
      ok: true,
      nodeId,
      leaseId,
      signal: controller.signal,
      task: cloneTask(task),
    };
  }

  function heartbeat(nodeId) {
    const task = tasks.get(nodeId);
    const lease = task ? leases.get(task.leaseId) : null;
    if (!task || !lease || TERMINAL_STATUSES.has(task.status)) return false;
    const timestampMs = now();
    const remainingMs = lease.absoluteDeadlineMs - timestampMs;
    if (remainingMs <= 0) {
      expire(lease.leaseId);
      return false;
    }
    clearTimer(lease.timer);
    lease.timer = setTimer(() => expire(lease.leaseId), Math.min(lease.heartbeatMs, remainingMs));
    task.updatedAt = new Date(timestampMs).toISOString();
    task.lastHeartbeatAt = task.updatedAt;
    persist(task);
    return cloneTask(task);
  }

  function complete(nodeId, result = {}, expectedAttemptId) {
    return transition(nodeId, 'success', {
      ...result,
      code: undefined,
      error: undefined,
      retryable: false,
    }, now(), expectedAttemptId);
  }

  function completeIfActive(nodeId, receiptPayloadHash, pendingReceiptId) {
    if (!/^[a-f\d]{64}$/i.test(String(receiptPayloadHash || ''))) return false;
    if (!String(pendingReceiptId || '').trim()) return false;
    const task = tasks.get(nodeId);
    if (!task || TERMINAL_STATUSES.has(task.status) || controllers.get(nodeId)?.signal.aborted) {
      return false;
    }
    const timestampMs = now();
    const finishedAt = new Date(timestampMs).toISOString();
    const schedulerCommitProof = createSchedulerCommitProof({
      runId: nodeId,
      receiptPayloadHash,
      finishedAt,
    });
    return transition(nodeId, 'success', {
      receiptPayloadHash,
      pendingReceiptId,
      schedulerCommitProof,
      code: undefined,
      error: undefined,
      retryable: false,
      remoteMayContinue: false,
      remoteCancelConfirmed: true,
    }, timestampMs);
  }

  function fail(nodeId, details = {}, expectedAttemptId) {
    return transition(nodeId, 'failed', {
      code: details.code || 'GENERATION_FAILED',
      error: details.error || '生成失败，请重试。',
      retryable: Boolean(details.retryable),
      ...details,
    }, now(), expectedAttemptId);
  }

  function cancel(nodeId, expectedAttemptId) {
    const task = tasks.get(nodeId);
    if (expectedAttemptId && task?.attemptId !== expectedAttemptId) {
      return { ok: false, code: 'GENERATION_ATTEMPT_CONFLICT', task: cloneTask(task) };
    }
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return { ok: false, code: 'GENERATION_NOT_ACTIVE', task: cloneTask(task) };
    }
    if (task.status === 'queued') {
      const entry = waitingByNodeId.get(nodeId);
      if (!entry || entry.attemptId !== task.attemptId) return { ok: false, code: 'GENERATION_NOT_ACTIVE', task: cloneTask(task) };
      const queue = waitingByModelId.get(task.modelIdKey) || [];
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) waitingByModelId.delete(task.modelIdKey);
      waitingByNodeId.delete(nodeId);
      let cancelled;
      try {
        cancelled = transition(nodeId, 'cancelled', { phase: 'not-submitted', queuePosition: undefined,
          code: 'GENERATION_CANCELLED', error: '排队已取消，没有提交生成。', retryable: false,
          remoteMayContinue: false }, now(), entry.attemptId);
      } catch {
        // It is already removed from the executable queue; restart also rejects waiters.
        cancelled = cloneTask(task);
      } finally {
        entry.resolve(admissionFailure('GENERATION_CANCELLED', '排队已取消，没有提交生成。', 499));
        try { updateQueuePositions(task.modelIdKey); } catch { failWaiting(task.modelIdKey); }
        scheduleDrain(task.modelIdKey);
      }
      return { ok: true, task: cancelled };
    }
    if (task.providerName === 'CodexImageProvider' && (task.remoteSubmissionStarted || task.remoteTasks?.length)) {
      const controller = controllers.get(nodeId);
      const uncertain = finalizeUnknown(nodeId, { code: 'GENERATION_OBSERVATION_INTERRUPTED',
        error: '已请求停止 Codex；原生图仍可能完成，正在核对结果，请勿重复生成。', remoteMayContinue: true }, task.attemptId);
      controller?.abort();
      return { ok: true, task: uncertain };
    }
    controllers.get(nodeId)?.abort();
    const cancelled = transition(nodeId, 'cancelled', {
      code: 'GENERATION_CANCELLED',
      error: '生成任务已取消。',
      retryable: true,
    });
    return { ok: true, task: cancelled };
  }

  function requestCancel(nodeId, details = {}) {
    const task = tasks.get(nodeId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return { ok: false, code: 'GENERATION_NOT_ACTIVE', task: cloneTask(task) };
    }
    controllers.get(nodeId)?.abort();
    const cancelling = update(nodeId, {
      phase: 'cancelling',
      cancellationRequestedAt: new Date(now()).toISOString(),
      remoteMayContinue: true,
      ...details,
    });
    return { ok: true, task: cancelling };
  }

  function finalizeCancel(nodeId, details = {}) {
    const cancelled = transition(nodeId, 'cancelled', {
      code: 'WORKFLOW_RUN_CANCELLED',
      error: '工作流测试已取消。',
      retryable: false,
      ...details,
    });
    return cancelled
      ? { ok: true, task: cancelled }
      : { ok: false, code: 'GENERATION_NOT_ACTIVE', task: getTask(nodeId) };
  }

  function finalizeUnknown(nodeId, details = {}, expectedAttemptId) {
    return transition(nodeId, 'unknown', {
      code: 'COMFYUI_SUBMISSION_UNKNOWN',
      error: '无法确认工作流是否已提交，系统不会自动重提。',
      retryable: false,
      remoteMayContinue: true,
      ...details,
    }, now(), expectedAttemptId);
  }

  function reconcileRemoteTask(nodeId, expectedAttemptId, status, details = {}) {
    const task = getTask(nodeId);
    if (!expectedAttemptId || task?.attemptId !== expectedAttemptId
      || !canRecoverGenerationTask(task) || !['success', 'failed', 'partial'].includes(status)) return false;
    const timestamp = new Date(now()).toISOString();
    const reconciled = {
      ...task, ...details, status: status === 'partial' ? 'unknown' : status, retryable: false, remoteMayContinue: false,
      code: status === 'success' ? undefined : details.code,
      error: status === 'success' ? undefined : details.error,
      diagnosticCode: status === 'success' ? 'GENERATION_RECOVERED' : details.code,
      updatedAt: timestamp, finishedAt: timestamp,
      durationMs: Math.max(0, now() - Date.parse(task.createdAt)),
    };
    persist(reconciled);
    tasks.set(nodeId, reconciled);
    return cloneTask(reconciled);
  }

  function recordRemoteTask(nodeId, expectedAttemptId, reference, slot = 0) {
    const task = getTask(nodeId);
    const remoteTask = sanitizeRemoteTaskReference(reference);
    if (!expectedAttemptId || task?.attemptId !== expectedAttemptId || !remoteTask
      || !isRecoverableProvider(task.kind, task.providerName) || task.providerName !== remoteTask.providerName) return false;
    let recordedReference = { remoteTask };
    if (task.kind === 'image') {
      if (!Number.isInteger(slot) || slot < 0 || slot >= task.requestedCount
        || slot >= task.remoteSubmissionCount) return false;
      const references = [...(task.remoteTasks || [])];
      if (references[slot] && JSON.stringify(references[slot]) !== JSON.stringify(remoteTask)) return false;
      references[slot] = remoteTask;
      recordedReference = { remoteTasks: references };
    }
    if (task.status === 'loading') return update(nodeId, recordedReference, expectedAttemptId);
    if (task.status !== 'unknown'
      || !['GENERATION_SUBMISSION_UNKNOWN', 'GENERATION_OBSERVATION_INTERRUPTED', 'GENERATION_INTERRUPTED'].includes(task.code)) return false;
    const recorded = {
      ...task, ...recordedReference, code: 'GENERATION_OBSERVATION_INTERRUPTED',
      diagnosticCode: 'GENERATION_OBSERVATION_INTERRUPTED', retryable: false,
      updatedAt: new Date(now()).toISOString(),
    };
    persist(recorded);
    tasks.set(nodeId, recorded);
    return cloneTask(recorded);
  }

  function getTask(nodeId) {
    return cloneTask(tasks.get(nodeId) || taskStore?.get?.(nodeId));
  }

  function isActive(nodeId) {
    const task = tasks.get(nodeId);
    const controller = task ? controllers.get(nodeId) : null;
    return task?.status === 'loading'
      && Boolean(task.leaseId && leases.has(task.leaseId) && controller && !controller.signal.aborted);
  }

  function dispose() {
    disposed = true;
    for (const entry of waitingByNodeId.values()) {
      const task = tasks.get(entry.nodeId);
      if (task?.attemptId === entry.attemptId && task.status === 'queued') {
        Object.assign(task, { status: 'failed', phase: 'not-submitted', queuePosition: undefined,
          code: 'GENERATION_NOT_SUBMITTED', diagnosticCode: 'GENERATION_NOT_SUBMITTED',
          error: '生成服务已停止，排队任务没有提交，请重新生成。', retryable: false,
          remoteMayContinue: false, updatedAt: new Date(now()).toISOString(), finishedAt: new Date(now()).toISOString() });
        try { persist(task); } catch { /* Restart recovery also terminates persisted waiters. */ }
      }
      entry.resolve(admissionFailure('GENERATION_NOT_SUBMITTED', '生成服务已停止，排队任务没有提交。'));
    }
    waitingByNodeId.clear();
    waitingByModelId.clear();
    scheduledModels.clear();
    for (const lease of leases.values()) clearTimer(lease.timer);
    leases.clear();
    inFlightByModelId.clear();
    controllers.clear();
  }

  return {
    acquire,
    adopt,
    begin,
    cancel,
    complete,
    completeIfActive,
    dispose,
    fail,
    finalizeCancel,
    finalizeUnknown,
    getConcurrency,
    getTask,
    heartbeat,
    isActive,
    pauseObservation,
    reacquireObservation,
    reconcileRemoteTask,
    recordRemoteTask,
    release,
    requestCancel,
    update,
  };
}

import { expandPromptTags } from '../prompt/promptPresets';
import type * as React from 'react';
export { useCanvasLocalWorkflows } from './canvasLocalWorkflows';
import type { CanvasNode } from '../nodes/canvasNodeOperations';
import { installGenerationScheduler } from './generationScheduler';
import {
  generateAudio,
  generateImage,
  generateText,
  generateVideo,
  getGenerationConcurrency,
} from './generationClient';
import { interruptedGenerationPatch } from './generationRecovery';
import { mergeImageResultHistory } from './imageResultHistory';
import {
  buildAudioRequest,
  buildImageRequest,
  buildTextRequest,
  buildVideoRequest,
  finite,
  text,
  type GenerationModels,
} from './canvasGenerationRequests';
import { inspectImage, inspectVideo } from '../media/generationMediaMetadata';

export { generateAudio, generateText, getGenerationConcurrency } from './generationClient';
export { inspectImage, extractVideoLastFrame } from '../media/generationMediaMetadata';
export interface GenerationBinding {
  getNodes(): CanvasNode[];
  getProjectId(): string | undefined;
  isActive?(): boolean;
  updateNode(id: string, patch: Partial<CanvasNode>): void;
}
interface Options extends GenerationModels {
  enabled: boolean;
  nodes: CanvasNode[];
  getNodes(): CanvasNode[];
  projectId?: string;
  updateNode(id: string, patch: Partial<CanvasNode>): void;
}
export interface GenerationRuntime {
  image: typeof generateImage;
  video: typeof generateVideo;
  audio: typeof generateAudio;
  text: typeof generateText;
  concurrency: typeof getGenerationConcurrency;
  inspectImage: typeof inspectImage;
  inspectVideo: typeof inspectVideo;
  now(): number;
}
const defaultRuntime: GenerationRuntime = {
  image: generateImage,
  video: generateVideo,
  audio: generateAudio,
  text: generateText,
  concurrency: getGenerationConcurrency,
  inspectImage,
  inspectVideo,
  now: Date.now,
};
function timeoutFor(estimate: string | undefined, multiplier: unknown) {
  const amount = parseInt(estimate ?? '', 10);
  const milliseconds =
    !estimate || !Number.isFinite(amount)
      ? 300000
      : estimate.includes('min')
        ? amount * 60000
        : estimate.includes('s')
          ? amount * 1000
          : amount;
  return Math.max(1000, milliseconds * 3 * Math.max(1, finite(multiplier, 1)));
}
export async function observeWithin<T>(promise: Promise<T>, timeoutMs: number, isQueued: () => boolean = () => false): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = timeoutMs;
  let observedAt = Date.now();
  let wasQueued = isQueued();
  const limit = new Promise<never>((_, reject) => {
    const check = () => {
      const now = Date.now(), queued = isQueued();
      // Start a full observation window when admission is first observed.
      if (!queued && !wasQueued) remaining -= now - observedAt;
      observedAt = now;
      wasQueued = queued;
      if (remaining <= 0) {
        reject(
          Object.assign(new Error('等待结果超时，正在核对原任务，请勿重复生成。'), {
            code: 'GENERATION_OBSERVATION_INTERRUPTED',
          }),
        );
        return;
      }
      timer = setTimeout(check, Math.min(1000, remaining));
    };
    timer = setTimeout(check, Math.min(1000, timeoutMs));
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const withTimestamp = (url: string, now: number) => {
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  const [path, hash] = url.split('#', 2);
  return `${path}${path.includes('?') ? '&' : '?'}t=${now}${hash === undefined ? '' : `#${hash}`}`;
};

export interface GenerationAuthorization {
  authorizationId?: string;
  planId?: string;
  /** Rechecked after asynchronous preflight, immediately before publishing/submitting. */
  valid(): boolean;
  request: string;
  submitted(attemptId: string): void;
  reserve?(attemptId: string): Promise<void>;
}
export async function prepareCanvasGenerationRequest(nodes: CanvasNode[], node: CanvasNode, projectId: string | undefined, models: GenerationModels) {
  const prompt = expandPromptTags(installGenerationScheduler().buildPrompt(nodes, node), {
    trailingParameters: node.imageModel === 'Midjourney Imagine · API',
  });
  return node.type === 'Image' ? buildImageRequest(nodes, node, prompt, projectId, models)
    : node.type === 'Video' ? buildVideoRequest(nodes, node, prompt, projectId, models)
      : node.type === 'Audio' ? buildAudioRequest(nodes, node, prompt, projectId, models)
        : buildTextRequest(nodes, node, prompt, projectId, models);
}

/** An attempt may submit once, and only its live document and node may accept its result. */
export function createCanvasGeneration(
  binding: GenerationBinding,
  models: GenerationModels,
  runtime: GenerationRuntime = defaultRuntime,
) {
  const scheduler = installGenerationScheduler();
  let disposed = false;
  const attempts = new Map<string, string>();
  return {
    async handleGenerate(id: string, authorization?: GenerationAuthorization) {
      const node = binding.getNodes().find((candidate) => candidate.id === id);
      if (
        authorization?.valid() === false ||
        disposed ||
        binding.isActive?.() === false ||
        !node ||
        ['queued', 'loading'].includes(text(node.status)) ||
        !['Image', 'Video', 'Audio', 'Text'].includes(node.type)
      )
        return;
      if (
        node.generationAttemptId &&
        node.generationDiagnosticCode === 'GENERATION_OBSERVATION_INTERRUPTED'
      )
        return;
      if (!scheduler.acquire(id)) return;
      const attempt = scheduler.currentAttempt(id)!;
      attempts.set(id, attempt);
      const projectId = binding.getProjectId(),
        nodes = binding.getNodes();
      const byId = new Map(nodes.map(node => [node.id, node]));
      const dependencies = new Map<string, CanvasNode | undefined>();
      const pending = [...(node.parentIds || [])];
      while (pending.length) {
        const parentId = pending.pop()!;
        if (dependencies.has(parentId)) continue;
        const parent = byId.get(parentId);
        dependencies.set(parentId, parent);
        for (const id of parent?.parentIds || []) pending.push(id);
      }
      const inputsUnchanged = () => {
        const current = new Map(binding.getNodes().map(node => [node.id, node]));
        return [...dependencies].every(([id, parent]) => current.get(id) === parent);
      };
      let startedAt: number | undefined;
      const duration = () => {
        const executionStart = binding.getNodes().find(candidate => candidate.id === id)?.generationExecutionStartedAt;
        return startedAt === undefined ? undefined : Math.max(0, runtime.now() - (typeof executionStart === 'number' ? executionStart : startedAt));
      };
      const owns = () => {
        const current = binding.getNodes().find((candidate) => candidate.id === id);
        return (
          !disposed &&
          binding.isActive?.() !== false &&
          attempts.get(id) === attempt &&
          scheduler.currentAttempt(id) === attempt &&
          binding.getProjectId() === projectId &&
          current?.type === node.type &&
          (startedAt === undefined ? current === node && inputsUnchanged() : current.generationAttemptId === attempt)
        );
      };
      const publish = (patch: Partial<CanvasNode>) => {
        if (owns()) binding.updateNode(id, patch);
      };
      try {
        const modelName = text(node[`${node.type.toLowerCase()}Model`]);
        const catalog =
          node.type === 'Image'
            ? models.imageModels
            : node.type === 'Video'
              ? models.videoModels
              : node.type === 'Text'
                ? models.textModels
                : models.audioModels;
        const model = catalog.find((candidate) => candidate.name === modelName);
        const prompt = expandPromptTags(scheduler.buildPrompt(nodes, node), {
          trailingParameters: node.imageModel === 'Midjourney Imagine · API',
        });
        const lyrics = node.type === 'Audio' && node.audioMode === 'lyrics-to-music';
        const stems = node.type === 'Audio' && node.audioModel === 'Suno Stems · API';
        const klingFrames =
          node.type === 'Video' &&
          text(node.videoModel).startsWith('kling-') &&
          (node.parentIds?.length ?? 0) >= 2;
        if (
          (!prompt && !lyrics && !stems && !klingFrames) ||
          (lyrics && !text(node.lyrics).trim()) ||
          (stems && !text(node.task_id).trim())
        ) {
          publish({
            status: 'error',
            errorMessage: lyrics
              ? '歌词模式请先填写歌词。'
              : stems
                ? '请填写原始 Suno task_id。'
                : '请输入提示词或连接文本节点后再生成。',
          });
          return;
        }
        const request = await prepareCanvasGenerationRequest(nodes, node, projectId, models);
        if (!owns()) return;
        if (authorization && (!authorization.valid() || authorization.request !== JSON.stringify(request))) return;
        if (authorization?.reserve) {
          await authorization.reserve(attempt);
          if (!owns() || !authorization.valid()) return;
        }
        // Keep previous visual media and its geometry until the new result is ready.
        const loading = {
          status: 'queued',
          projectId: projectId || undefined,
          generationStartTime: runtime.now(),
          generationQueuedAt: runtime.now(),
          generationQueuePosition: undefined,
          generationExecutionStartedAt: undefined,
          generationAttemptId: attempt,
          generationDiagnosticCode: undefined,
          errorMessage: undefined,
          ...(['Image', 'Video'].includes(node.type) ? {} : { resultUrl: undefined, resultUrls: undefined }),
        };
        publish(loading);
        startedAt = loading.generationStartTime;
        if (!owns()) return;
        const ownedRequest = { ...request, generationAttemptId: attempt,
          ...(authorization?.authorizationId ? { agentAuthorizationId: authorization.authorizationId } : {}),
          ...(authorization?.planId ? { agentPlanId: authorization.planId } : {}) };
        const timeout = timeoutFor(
          model?.timeEstimate,
          node.type === 'Video' ? node.duration : node.generateCount,
        );
        authorization?.submitted(attempt);
        const isQueued = () => binding.getNodes().find(candidate => candidate.id === id)?.status === 'queued';
        let patch: Partial<CanvasNode>;
        if (node.type === 'Text') {
          const result = await observeWithin(runtime.text(ownedRequest), timeout, isQueued);
          patch = { textContent: result.text };
        } else {
          const generate =
            node.type === 'Image'
              ? runtime.image
              : node.type === 'Video'
                ? runtime.video
                : runtime.audio;
          const result = await observeWithin(generate(ownedRequest), timeout, isQueued);
          if (!owns()) return;
          const urls = (Array.isArray(result) ? result : [result]).map((url) =>
            withTimestamp(url, runtime.now()),
          );
          if (node.type === 'Image') {
            const metadata = await runtime.inspectImage(urls[0]).catch(() => ({}));
            if (!owns()) return;
            const current = binding.getNodes().find((candidate) => candidate.id === id)!;
            const history = mergeImageResultHistory({ resultUrl: current.resultUrl, resultUrls: current.resultUrls }, urls);
            patch = {
              ...history,
              ...('resultAspectRatio' in metadata
                ? { resultAspectRatio: metadata.resultAspectRatio }
                : {}),
            };
          } else if (node.type === 'Video') {
            const metadata = await runtime.inspectVideo(urls[0]).catch(() => ({}));
            patch = { resultUrl: urls[0], resultUrls: urls, lastFrame: undefined,
              resultAspectRatio: undefined, naturalWidth: undefined, naturalHeight: undefined, ...metadata };
          } else patch = { resultUrl: urls[0], resultUrls: urls };
        }
        publish({
          ...patch,
          status: 'success',
          errorMessage: undefined,
          networkUrl: null,
          generationStartTime: undefined,
          generationAttemptId: undefined,
          generationQueuedAt: undefined,
          generationQueuePosition: undefined,
          generationExecutionStartedAt: undefined,
          generationDurationMs: duration(),
          generationDiagnosticCode: undefined,
        });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const code =
          'code' in failure && typeof failure.code === 'string'
            ? failure.code
            : 'GENERATION_FAILED';
        const message = /permission_denied|\b403\b/i.test(failure.message)
          ? '权限被拒绝。请检查 API Key 配置。'
          : failure.message || '生成任务失败';
        publish({
          status: code === 'GENERATION_CANCELLED' ? 'cancelled' : 'error',
          errorMessage: message,
          generationDiagnosticCode: code,
          generationStartTime: undefined,
          generationAttemptId: undefined,
          generationQueuedAt: undefined,
          generationQueuePosition: undefined,
          generationExecutionStartedAt: undefined,
          generationDurationMs: duration(),
          ...(startedAt === undefined
            ? {}
            : interruptedGenerationPatch(Object.assign(failure, { code }), attempt)),
        });
      } finally {
        if (attempts.get(id) === attempt) attempts.delete(id);
        scheduler.release(id, attempt);
      }
    },
    dispose() {
      disposed = true;
      attempts.forEach((attempt, id) => scheduler.release(id, attempt));
      attempts.clear();
    },
  };
}

export function useCanvasGeneration(
  hooks: Pick<typeof React, 'useRef' | 'useEffect'>,
  options: Options,
) {
  const input = hooks.useRef(options);
  input.current = options;
  const owner = hooks.useRef<ReturnType<typeof createCanvasGeneration> | null>(null);
  const { imageModels, videoModels, audioModels, textModels, projectId, enabled } = options;
  hooks.useEffect(() => {
    if (!enabled) return;
    const controller = createCanvasGeneration(
      {
        getNodes: () => input.current.getNodes(),
        getProjectId: () => input.current.projectId,
        isActive: () => input.current.enabled,
        updateNode: (id, patch) => input.current.updateNode(id, patch),
      },
      { imageModels, videoModels, audioModels, textModels },
    );
    owner.current = controller;
    return () => {
      controller.dispose();
      if (owner.current === controller) owner.current = null;
    };
  }, [projectId, enabled, imageModels, videoModels, audioModels, textModels]);
  return { handleGenerate: (id: string, authorization?: GenerationAuthorization) => owner.current?.handleGenerate(id, authorization) };
}

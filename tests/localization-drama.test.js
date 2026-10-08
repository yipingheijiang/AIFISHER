import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDramaExecutionService } from '../server/agent/drama/dramaExecutionService.js';
import { classifyGenerationError } from '../server/generation/generationErrors.js';
import { OFFICIAL_DRAMA_BUNDLE } from '../server/agent/drama/officialDramaBundle.js';

describe('retired automatic scene recipe', () => {
  it('rejects an incomplete recipe before any paid character task or attempt is written', async () => {
    const prefix = path.join(os.tmpdir(), 'aifisher-localization-test-');
    const root = await fs.mkdtemp(prefix);
    const plan = { id: 'plan', projectId: 'project', revision: 1, approvedRevision: 1, assets: [
      { id: 'character', kind: 'character', prompt: 'local character', width: 1024, height: 1024 },
      { id: 'scene', kind: 'scene', prompt: 'local scene', width: 1024, height: 1024 },
    ] };
    const start = vi.fn();
    const service = createDramaExecutionService({ planStore: { get: async () => plan },
      libraryDirectory: path.join(root, 'library'), generationCoordinator: {}, compileSegment: vi.fn(),
      testRunService: { start }, runningHubLibraryService: { createApp: vi.fn() } });
    try {
      for (const assetId of ['character', 'scene']) {
        await expect(service.beginAsset({ planId: plan.id, projectId: plan.projectId, planRevision: 1,
          assetId, attemptId: 'attempt', confirmPaidExecution: true, maxAssets: 1 })).rejects.toMatchObject({ code: 'LOCAL_EDITION_SOURCE_REMOVED' });
      }
      expect(start).not.toHaveBeenCalled();
      expect(await service.getPlanExecution({ planId: plan.id, projectId: plan.projectId })).toMatchObject({ assets: [] });
      await expect(service.withEditablePlan({ planId: plan.id, projectId: plan.projectId }, async () => 'still editable')).resolves.toBe('still editable');
    } finally {
      expect(path.resolve(root).startsWith(path.resolve(prefix))).toBe(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('keeps permanent service removals nonretryable and exposes no removed source', () => {
    for (const code of ['REMOVED_SERVICE_URL', 'LOCAL_EDITION_SOURCE_REMOVED'])
      expect(classifyGenerationError({ code, status: 400 })).toMatchObject({ code, retryable: false });
    expect(OFFICIAL_DRAMA_BUNDLE.scenes.provider).toBeNull();
    expect(JSON.stringify(OFFICIAL_DRAMA_BUNDLE)).not.toMatch(/relay|work-fisher/i);
  });
});

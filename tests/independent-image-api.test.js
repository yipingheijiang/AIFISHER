import '../server/security/installOutboundPolicy.js';
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createConfigRouter } from '../server/routes/config.js';
import { buildSourceSettings } from '../server/generation/modelAvailability.js';
import { loadModelCatalog } from '../server/config/modelCatalog.js';
import { modelOverrideKey } from '../src/shared/modelOverrideKey.js';
import { createGenerationCoordinator } from '../server/generation/generationCoordinator.js';
import { createGenerationRouter } from '../server/routes/generation.js';
import { createModelSourceRouter } from '../server/generation/modelSourceRouter.js';
import { saveMediaBufferToFile } from '../server/utils/imageHelpers.js';

// Keep the real config, dispatcher, coordinator, provider and HTTP transport.
// Only the final asset write is isolated from the user's media library.
vi.mock('../server/utils/imageHelpers.js', async importOriginal => ({
  ...await importOriginal(),
  saveMediaBufferToFile: vi.fn(() => ({ url: '/library/mock-image.png' })),
}));

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

describe('independent image API configuration', () => {
  it('exposes separate image generation/edit endpoint settings without returning credentials', () => {
    const model = loadModelCatalog()['GPT Image 2'];
    const values = { OPENAI_API_KEY: 'test-secret-value', MODEL_URL_GPT_IMAGE_2: 'http://127.0.0.1:1234/legacy' };
    const blocks = buildSourceSettings({ catalog: { [model.name]: model }, readSecret: key => values[key] });
    const image = blocks[0].media[0].models[0];
    expect(image.endpoints).toEqual([
      { mode: 'text-to-image', defaultUrl: 'https://api.openai.com/v1/images/generations', customUrl: values.MODEL_URL_GPT_IMAGE_2 },
      { mode: 'image-to-image', defaultUrl: 'https://api.openai.com/v1/images/edits', customUrl: values.MODEL_URL_GPT_IMAGE_2 },
      { mode: 'image-inpainting', defaultUrl: 'https://api.openai.com/v1/images/edits', customUrl: values.MODEL_URL_GPT_IMAGE_2 },
    ]);
    expect(JSON.stringify(blocks)).not.toContain(values.OPENAI_API_KEY);
  });

  it('saves a third-party key, model and per-mode URLs, then routes text/edit generation to that server', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aifisher-image-api-'));
    const touched = ['OPENAI_API_KEY', modelOverrideKey('GPT Image 2'), 'MODEL_URL_GPT_IMAGE_2', 'MODEL_URL_GPT_IMAGE_2_TEXT_TO_IMAGE', 'MODEL_URL_GPT_IMAGE_2_IMAGE_TO_IMAGE'];
    const before = Object.fromEntries(touched.map(key => [key, process.env[key]]));
    const coordinator = createGenerationCoordinator();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=', 'base64');
    const received = [];
    const mock = express();
    mock.use(express.raw({ type: () => true }));
    mock.post('/v1/images/generations', (req, res) => {
      received.push({ path: req.path, auth: req.headers.authorization, body: JSON.parse(req.body.toString()) });
      res.json({ data: [{ b64_json: png.toString('base64') }] });
    });
    mock.post('/v1/images/edits', (req, res) => {
      received.push({ path: req.path, auth: req.headers.authorization, body: req.body.toString(), type: req.headers['content-type'] });
      res.json({ data: [{ url: `http://127.0.0.1:${req.socket.localPort}/asset.png` }] });
    });
    mock.get('/asset.png', (_req, res) => res.type('png').send(png));
    try {
      await withServer(mock, async providerBase => {
        let credentials = {};
        const envPath = path.join(dir, 'providers.env');
        const app = express(); app.use(express.json());
        Object.defineProperty(app.locals, 'OPENAI_API_KEY', { get: () => credentials.OPENAI_API_KEY });
        app.locals.LOGS_DIR = path.join(dir, 'logs');
        app.use('/api/config', createConfigRouter({ envPath, modelNames: ['GPT Image 2'], credentialStore: { read: async () => credentials, update: async patch => { credentials = { ...credentials, ...patch }; } }, logger: { log() {}, error() {} } }));
        app.use('/api', createGenerationRouter({ generationCoordinator: coordinator }));
        app.use('/api', createModelSourceRouter());
        await withServer(app, async base => {
          for (const url of ['/v1/images/generations', 'ftp://example.invalid/images', 'https://user:pass@example.invalid/images', 'https://api.work-fisher.com/v1/images/generations']) {
            const rejected = await fetch(base + '/api/config/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ MODEL_URL_GPT_IMAGE_2_TEXT_TO_IMAGE: url, OPENAI_API_KEY: 'should-not-be-saved' }) });
            expect(rejected.status).toBe(400);
            expect(credentials).toEqual({});
          }
          const values = { OPENAI_API_KEY: 'test-independent-key', [modelOverrideKey('GPT Image 2')]: 'custom-image-model', MODEL_URL_GPT_IMAGE_2: '', MODEL_URL_GPT_IMAGE_2_TEXT_TO_IMAGE: providerBase + '/v1/images/generations', MODEL_URL_GPT_IMAGE_2_IMAGE_TO_IMAGE: providerBase + '/v1/images/edits' };
          const saved = await fetch(base + '/api/config/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
          expect(saved.status).toBe(200);
          expect(await readFile(envPath, 'utf8')).not.toContain(values.OPENAI_API_KEY);
          const settings = await (await fetch(base + '/api/config/keys')).json();
          expect(settings.OPENAI_API_KEY).not.toBe(values.OPENAI_API_KEY);
          expect(settings.MODEL_URL_GPT_IMAGE_2_TEXT_TO_IMAGE).toBe(values.MODEL_URL_GPT_IMAGE_2_TEXT_TO_IMAGE);
          const sources = await (await fetch(base + '/api/generation/sources')).json();
          const image = sources.blocks.flatMap(block => block.media.flatMap(media => media.models)).find(model => model.name === 'GPT Image 2');
          expect(image.endpoints.find(endpoint => endpoint.mode === 'text-to-image').customUrl).toBe(values.MODEL_URL_GPT_IMAGE_2_TEXT_TO_IMAGE);
          expect(image.configured).toBe(true);
          expect(JSON.stringify(sources)).not.toContain(values.OPENAI_API_KEY);
          for (const mode of ['text-to-image', 'image-to-image']) {
            const response = await fetch(base + '/api/generate-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageModel: 'GPT Image 2', imageMode: mode, nodeId: mode, prompt: 'local mock', resolution: '1K', aspectRatio: '1:1', ...(mode === 'image-to-image' ? { images: ['data:image/png;base64,' + png.toString('base64')] } : {}) }) });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ resultUrl: '/library/mock-image.png' });
          }
          expect(received).toHaveLength(2);
          expect(received.every(request => request.auth === 'Bearer test-independent-key')).toBe(true);
          expect(received[0].body.model).toBe('custom-image-model');
          expect(received[1].type).toMatch(/^multipart\/form-data; boundary=/);
          expect(received[1].body).toContain('name="image[]"');
          expect(received[1].body).toContain('custom-image-model');
          expect(saveMediaBufferToFile.mock.calls.slice(-2).every(call => call[0].equals(png))).toBe(true);
        });
      });
    } finally {
      coordinator.dispose();
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

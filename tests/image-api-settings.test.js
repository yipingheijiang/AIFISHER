// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mountSourceSettings } from '../src/stable/generation/sourceSettings';

describe('third-party image settings workflow', () => {
  it('saves distinct complete URLs and a model ID together with the vendor key, then restores defaults', async () => {
    const host = document.createElement('main'); document.body.append(host);
    const saveKeys = vi.fn(async () => {});
    const model = { name: 'GPT Image 2', configured: false, requiredSecrets: ['OPENAI_API_KEY'], modelIds: ['gpt-image-2'], endpoints: [{ mode: 'text-to-image', defaultUrl: 'https://api.openai.com/v1/images/generations', customUrl: '' }, { mode: 'image-to-image', defaultUrl: 'https://api.openai.com/v1/images/edits', customUrl: '' }] };
    const client = { getBlocks: async () => [{ source: 'direct', label: '厂商与兼容 API', singleKey: true, secrets: [{ key: 'OPENAI_API_KEY', configured: false }], media: [{ kind: 'image', models: [model] }] }], saveKeys };
    const dispose = mountSourceSettings(host, client);
    try {
      await vi.waitFor(() => expect(host.querySelector('[aria-label="自定义模型 ID"]')).toBeTruthy());
      const textUrl = host.querySelector('[aria-label="文生图 API 地址"]');
      const editUrl = host.querySelector('[aria-label="图生图 API 地址"]');
      expect(textUrl).toBeTruthy(); expect(editUrl).toBeTruthy();
      const key = host.querySelector('[data-fisherai-secret-field="OPENAI_API_KEY"] input');
      key.value = 'test-independent-key'; key.dispatchEvent(new Event('input'));
      host.querySelector('[aria-label="自定义模型 ID"]').value = 'custom-image-model';
      const save = [...host.querySelectorAll('button')].find(button => button.textContent === '保存连接配置');
      textUrl.value = '/v1/images/generations'; save.click();
      expect(saveKeys).not.toHaveBeenCalled();
      expect(key.value).toBe('test-independent-key');
      textUrl.value = 'http://127.0.0.1:1234/v1/images/generations';
      editUrl.value = 'http://127.0.0.1:1234/v1/images/edits';
      save.click();
      await vi.waitFor(() => expect(saveKeys).toHaveBeenCalledOnce());
      expect(saveKeys.mock.calls[0][0]).toMatchObject({ OPENAI_API_KEY: 'test-independent-key', MODEL_URL_GPT_IMAGE_2: '', MODEL_URL_GPT_IMAGE_2_TEXT_TO_IMAGE: textUrl.value, MODEL_URL_GPT_IMAGE_2_IMAGE_TO_IMAGE: editUrl.value });
      expect(key.value).toBe('');
      const reset = [...host.querySelectorAll('button')].find(button => button.textContent === '恢复默认');
      await vi.waitFor(() => expect(reset.disabled).toBe(false)); reset.click();
      await vi.waitFor(() => expect(saveKeys).toHaveBeenCalledTimes(2));
      expect(saveKeys.mock.calls[1][0]).toMatchObject({ MODEL_URL_GPT_IMAGE_2_TEXT_TO_IMAGE: '', MODEL_URL_GPT_IMAGE_2_IMAGE_TO_IMAGE: '' });
      await vi.waitFor(() => { expect(textUrl.value).toBe(''); expect(editUrl.value).toBe(''); });
    } finally { dispose(); host.remove(); }
  });
});

import { GenerationTaskError } from '../generation/generationExecution.js';

export const CodexImageProvider = {
  async generateImage(params, context) {
    if (!context?.CODEX_IMAGES) throw new GenerationTaskError({ code: 'CODEX_UNAVAILABLE', status: 503, retryable: false, message: 'Codex 生图服务尚未就绪。' });
    try { return await context.CODEX_IMAGES.generate(params, context); }
    catch (error) {
      throw Object.assign(new GenerationTaskError({ code: error.code || 'CODEX_IMAGE_FAILED', status: error.status || 502,
        retryable: false, message: error.message || 'Codex 生图未完成。' }), {
        expose: true,
        providerTaskFailed: error.providerTaskFailed === true, submissionUncertain: error.submissionUncertain === true,
      });
    }
  },
  canRecoverImage(reference, _params, context) { return context.CODEX_IMAGES?.canRecover(reference) ?? false; },
  recoverImage(task, _params, context) { return context.CODEX_IMAGES.recover(task); },
};

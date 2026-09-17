import { Resend } from 'resend';
import { handleWebhook } from '../src/handle-webhook.ts';

/**
 * Vercel Serverless Function 入口
 * 使用 Web 标准签名（fetch + Request/Response），不依赖 Vercel 特有 API
 * 业务逻辑全部位于 src/handle-webhook.ts，此处只负责注入依赖
 */
export default {
  fetch(request: Request): Promise<Response> {
    return handleWebhook(request, process.env, new Resend(process.env.RESEND_API_KEY));
  },
};

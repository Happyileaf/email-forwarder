import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Resend } from 'resend';
import { handleWebhook, type ForwarderEnv } from '../src/handle-webhook.ts';

const baseEnv: ForwarderEnv = {
  RESEND_API_KEY: 'test-key',
  FORWARD_TO: 'target@example.com',
  FORWARD_FROM: 'forwarder@verified.example.com',
};

const receivedEvent = {
  type: 'email.received',
  data: { email_id: 'email-1' },
};

const sampleEmail = {
  object: 'email',
  id: 'email-1',
  to: ['inbound@verified.example.com'],
  from: 'sender@example.com',
  created_at: '2026-09-17T08:00:00.000Z',
  subject: 'Hello <World>',
  bcc: null,
  cc: null,
  reply_to: null,
  received_for: ['inbound@verified.example.com'],
  html: '<p>hi</p>',
  text: 'hi',
  headers: null,
  message_id: 'msg-1',
  attachments: [],
};

interface SendCall {
  params: Record<string, unknown>;
  options?: { idempotencyKey?: string };
}

interface FakeResendOptions {
  email?: Record<string, unknown>;
  verifyThrows?: boolean;
  getError?: { message: string; statusCode: number | null };
  sendError?: { message: string; statusCode: number | null };
  sendCalls?: SendCall[];
}

function makeFakeResend(options: FakeResendOptions = {}): Resend {
  const fake = {
    webhooks: {
      verify: ({ payload }: { payload: string }) => {
        if (options.verifyThrows) {
          throw new Error('invalid signature');
        }
        return JSON.parse(payload) as unknown;
      },
    },
    emails: {
      receiving: {
        get: async () =>
          options.getError
            ? { data: null, error: options.getError }
            : { data: options.email ?? sampleEmail, error: null },
        attachments: {
          list: async () => ({
            data: {
              object: 'list',
              has_more: false,
              data: [
                {
                  id: 'att-1',
                  filename: 'a.txt',
                  size: 3,
                  content_type: 'text/plain',
                  content_disposition: 'attachment',
                  download_url: 'https://example.com/a.txt',
                  expires_at: '2026-09-17T09:00:00.000Z',
                },
              ],
            },
            error: null,
          }),
        },
      },
      send: async (params: Record<string, unknown>, sendOptions?: { idempotencyKey?: string }) => {
        options.sendCalls?.push({ params, options: sendOptions });
        return options.sendError
          ? { data: null, error: options.sendError }
          : { data: { id: 'sent-1' }, error: null };
      },
    },
  };
  return fake as unknown as Resend;
}

function makeRequest(body: unknown, method = 'POST'): Request {
  if (method === 'GET') {
    return new Request('http://localhost/api/webhook', { method });
  }
  return new Request('http://localhost/api/webhook', {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('handleWebhook', () => {
  it('非 POST 请求返回 405', async () => {
    const response = await handleWebhook(makeRequest(null, 'GET'), baseEnv, makeFakeResend());
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  });

  it('缺少必要环境变量返回 500', async () => {
    const response = await handleWebhook(makeRequest(receivedEvent), {}, makeFakeResend());
    assert.equal(response.status, 500);
  });

  it('未配置签名密钥时非法 JSON 返回 400', async () => {
    const response = await handleWebhook(makeRequest('not-json'), baseEnv, makeFakeResend());
    assert.equal(response.status, 400);
  });

  it('签名校验失败返回 401', async () => {
    const env: ForwarderEnv = { ...baseEnv, RESEND_WEBHOOK_SECRET: 'whsec_test' };
    const response = await handleWebhook(
      makeRequest(receivedEvent),
      env,
      makeFakeResend({ verifyThrows: true }),
    );
    assert.equal(response.status, 401);
  });

  it('非 email.received 事件返回 200 并忽略', async () => {
    const response = await handleWebhook(
      makeRequest({ type: 'email.sent', data: {} }),
      baseEnv,
      makeFakeResend(),
    );
    assert.equal(response.status, 200);
    assert.equal((await readJson(response)).ignored, true);
  });

  it('缺少 email_id 返回 400', async () => {
    const response = await handleWebhook(
      makeRequest({ type: 'email.received', data: {} }),
      baseEnv,
      makeFakeResend(),
    );
    assert.equal(response.status, 400);
  });

  it('正常转发：区分原始发件人与转发身份并使用幂等键', async () => {
    const sendCalls: SendCall[] = [];
    const response = await handleWebhook(
      makeRequest(receivedEvent),
      baseEnv,
      makeFakeResend({ sendCalls }),
    );
    assert.equal(response.status, 200);
    assert.equal(sendCalls.length, 1);
    const call = sendCalls[0]!;
    const params = call.params;
    assert.equal(params.to, 'target@example.com');
    assert.equal(params.from, 'forwarder@verified.example.com');
    assert.equal(params.replyTo, 'sender@example.com');
    assert.equal(params.subject, 'Fwd: Hello <World>');
    assert.equal(call.options?.idempotencyKey, 'email-1');
    assert.match(String(params.text), /From: sender@example\.com/);
    assert.match(String(params.html), /Hello &lt;World&gt;/);
    const headers = params.headers as Record<string, string>;
    assert.equal(headers['X-Original-From'], 'sender@example.com');
    assert.equal(headers['X-Original-To'], 'inbound@verified.example.com');
  });

  it('包含附件时下载并原样转发附件', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])));
    const sendCalls: SendCall[] = [];
    const email = { ...sampleEmail, attachments: [{ id: 'att-1' }] };
    const response = await handleWebhook(
      makeRequest(receivedEvent),
      baseEnv,
      makeFakeResend({ email, sendCalls }),
    );
    assert.equal(response.status, 200);
    const attachments = sendCalls[0]?.params.attachments as {
      filename: string;
      content: Buffer;
      contentType: string;
    }[];
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.filename, 'a.txt');
    assert.equal(attachments[0]!.contentType, 'text/plain');
    assert.deepEqual([...attachments[0]!.content], [1, 2, 3]);
  });

  it('获取完整邮件失败返回 502', async () => {
    const response = await handleWebhook(
      makeRequest(receivedEvent),
      baseEnv,
      makeFakeResend({ getError: { message: 'not found', statusCode: 404 } }),
    );
    assert.equal(response.status, 502);
  });

  it('发送返回 409 时视为重复投递并返回成功', async () => {
    const response = await handleWebhook(
      makeRequest(receivedEvent),
      baseEnv,
      makeFakeResend({ sendError: { message: 'conflict', statusCode: 409 } }),
    );
    assert.equal(response.status, 200);
    assert.equal((await readJson(response)).deduplicated, true);
  });

  it('发送失败返回 502', async () => {
    const response = await handleWebhook(
      makeRequest(receivedEvent),
      baseEnv,
      makeFakeResend({ sendError: { message: 'boom', statusCode: 500 } }),
    );
    assert.equal(response.status, 502);
  });
});

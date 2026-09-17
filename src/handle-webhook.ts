import type { Attachment, CreateEmailOptions, Resend } from 'resend';

/**
 * 服务运行依赖的环境变量
 * RESEND_API_KEY、FORWARD_TO、FORWARD_FROM 缺失时服务无法工作
 * RESEND_WEBHOOK_SECRET 缺失时跳过 Webhook 签名校验，仅限本地调试
 */
export interface ForwarderEnv {
  RESEND_API_KEY?: string;
  FORWARD_TO?: string;
  FORWARD_FROM?: string;
  RESEND_WEBHOOK_SECRET?: string;
}

interface ForwarderConfig {
  forwardTo: string;
  forwardFrom: string;
  webhookSecret?: string;
}

/**
 * 完整邮件中参与转发的字段
 * 使用窄接口而非 SDK 内部类型，降低与 Resend SDK 版本的耦合
 */
interface ReceivedEmailContent {
  from: string;
  to: string[];
  subject: string | null;
  created_at: string;
  html: string | null;
  text: string | null;
}

type ParsedEvent =
  | { kind: 'received'; emailId: string }
  | { kind: 'ignored' }
  | { kind: 'invalid' };

/** 统一 JSON 响应格式，避免各分支重复构造 Header */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** 附件列表单次拉取上限，覆盖正常邮件的附件数量 */
const ATTACHMENT_LIST_LIMIT = 100;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  const headers: Record<string, string> = { 'content-type': JSON_CONTENT_TYPE };
  if (status === 405) {
    headers.allow = 'POST';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function readConfig(env: ForwarderEnv): ForwarderConfig | null {
  if (!env.RESEND_API_KEY || !env.FORWARD_TO || !env.FORWARD_FROM) {
    return null;
  }
  const config: ForwarderConfig = {
    forwardTo: env.FORWARD_TO,
    forwardFrom: env.FORWARD_FROM,
  };
  if (env.RESEND_WEBHOOK_SECRET) {
    config.webhookSecret = env.RESEND_WEBHOOK_SECRET;
  }
  return config;
}

function parseEventPayload(payload: unknown): ParsedEvent {
  if (typeof payload !== 'object' || payload === null) {
    return { kind: 'invalid' };
  }
  const type = (payload as { type?: unknown }).type;
  if (type !== 'email.received') {
    return { kind: 'ignored' };
  }
  const data = (payload as { data?: unknown }).data;
  const emailId =
    typeof data === 'object' && data !== null
      ? (data as { email_id?: unknown }).email_id
      : undefined;
  if (typeof emailId !== 'string' || emailId.length === 0) {
    return { kind: 'invalid' };
  }
  return { kind: 'received', emailId };
}

async function readAndVerifyEvent(
  request: Request,
  resend: Resend,
  webhookSecret: string | undefined,
): Promise<{ event: unknown } | { response: Response }> {
  const payload = await request.text();
  if (!webhookSecret) {
    console.warn('RESEND_WEBHOOK_SECRET 未配置，跳过 Webhook 签名校验');
    try {
      return { event: JSON.parse(payload) as unknown };
    } catch {
      return { response: jsonResponse(400, { ok: false, error: 'invalid json body' }) };
    }
  }
  try {
    const event = resend.webhooks.verify({
      payload,
      headers: {
        id: request.headers.get('svix-id') ?? '',
        timestamp: request.headers.get('svix-timestamp') ?? '',
        signature: request.headers.get('svix-signature') ?? '',
      },
      webhookSecret,
    });
    return { event };
  } catch {
    return { response: jsonResponse(401, { ok: false, error: 'invalid signature' }) };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildForwardParams(
  email: ReceivedEmailContent,
  config: ForwarderConfig,
  attachments: Attachment[],
): CreateEmailOptions {
  const subject = email.subject && email.subject.trim().length > 0 ? email.subject : '(no subject)';
  const originalTo = email.to.join(', ');
  const metaLines = [
    '---------- Forwarded message ----------',
    `From: ${email.from}`,
    `To: ${originalTo}`,
    `Date: ${email.created_at}`,
    `Subject: ${subject}`,
  ];
  const text = `${metaLines.join('\n')}\n\n${email.text ?? ''}`;
  const metaHtml =
    `<div style="padding:12px;margin-bottom:16px;border-left:3px solid #ddd;font-size:13px;color:#555">` +
    `<strong>---------- Forwarded message ----------</strong><br>` +
    `From: ${escapeHtml(email.from)}<br>` +
    `To: ${escapeHtml(originalTo)}<br>` +
    `Date: ${escapeHtml(email.created_at)}<br>` +
    `Subject: ${escapeHtml(subject)}</div>`;
  return {
    from: config.forwardFrom,
    to: config.forwardTo,
    replyTo: email.from,
    subject: `Fwd: ${subject}`,
    text,
    headers: {
      'X-Original-From': email.from,
      'X-Original-To': originalTo,
    },
    ...(email.html ? { html: metaHtml + email.html } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

async function downloadAttachments(
  resend: Resend,
  emailId: string,
  attachmentCount: number,
): Promise<Attachment[] | null> {
  if (attachmentCount === 0) {
    return [];
  }
  const { data: list, error } = await resend.emails.receiving.attachments.list({
    emailId,
    limit: ATTACHMENT_LIST_LIMIT,
  });
  if (error || !list) {
    console.error('获取附件列表失败', { emailId, error: error?.message });
    return null;
  }
  const attachments: Attachment[] = [];
  for (const item of list.data) {
    const response = await fetch(item.download_url);
    if (!response.ok) {
      console.error('下载附件失败', { emailId, attachmentId: item.id, status: response.status });
      return null;
    }
    const content = Buffer.from(await response.arrayBuffer());
    attachments.push({
      filename: item.filename ?? 'attachment',
      content,
      contentType: item.content_type,
      ...(item.content_id ? { contentId: item.content_id } : {}),
    });
  }
  return attachments;
}

/**
 * 处理 Resend Inbound Email Webhook：校验来源后拉取完整邮件并转发到目标邮箱
 * @param request 标准 Web Request，便于迁移到非 Vercel 平台
 * @param env 环境变量
 * @param resend Resend 客户端，由调用方注入以便测试
 * @returns 标准 Web Response，所有错误均转换为对应状态码，不抛出异常
 */
export async function handleWebhook(
  request: Request,
  env: ForwarderEnv,
  resend: Resend,
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'method not allowed' });
  }
  const config = readConfig(env);
  if (!config) {
    console.error('缺少必要的环境变量：RESEND_API_KEY / FORWARD_TO / FORWARD_FROM');
    return jsonResponse(500, { ok: false, error: 'server misconfigured' });
  }

  const verified = await readAndVerifyEvent(request, resend, config.webhookSecret);
  if ('response' in verified) {
    return verified.response;
  }

  const parsed = parseEventPayload(verified.event);
  if (parsed.kind === 'ignored') {
    return jsonResponse(200, { ok: true, ignored: true });
  }
  if (parsed.kind === 'invalid') {
    return jsonResponse(400, { ok: false, error: 'missing email_id' });
  }

  const emailId = parsed.emailId;
  const { data: email, error: fetchError } = await resend.emails.receiving.get(emailId, {
    html_format: 'cid',
  });
  if (fetchError || !email) {
    console.error('获取完整邮件失败', { emailId, error: fetchError?.message });
    return jsonResponse(502, { ok: false, error: 'failed to fetch email' });
  }

  const attachments = await downloadAttachments(resend, emailId, email.attachments.length);
  if (attachments === null) {
    return jsonResponse(502, { ok: false, error: 'failed to download attachments' });
  }

  const { error: sendError } = await resend.emails.send(
    buildForwardParams(email, config, attachments),
    { idempotencyKey: emailId },
  );
  if (sendError) {
    /**
     * 409 表示同一幂等键已提交过不同内容，说明该邮件此前已成功转发
     * 重复 Webhook 属于正常投递行为，按成功处理避免无意义重试
     */
    if (sendError.statusCode === 409) {
      return jsonResponse(200, { ok: true, deduplicated: true });
    }
    console.error('转发邮件失败', { emailId, error: sendError.message });
    return jsonResponse(502, { ok: false, error: 'failed to forward email' });
  }

  console.log('邮件转发成功', { emailId, from: email.from, subject: email.subject });
  return jsonResponse(200, { ok: true });
}

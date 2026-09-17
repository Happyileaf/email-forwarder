import type { Attachment, CreateEmailOptions, Resend } from 'resend';

/** 服务运行依赖的环境变量，前三个必要项缺失时服务无法工作 */
export interface ForwarderEnv {
  /** Resend API Key，调用收信与发信接口的凭证 */
  RESEND_API_KEY?: string;
  /** 转发目标邮箱 */
  FORWARD_TO?: string;
  /** 转发发件地址，需使用 Resend 已验证域名 */
  FORWARD_FROM?: string;
  /** Webhook 签名密钥，缺失时跳过签名校验，仅限本地调试 */
  RESEND_WEBHOOK_SECRET?: string;
}

/** 从环境变量解析出的运行配置，必要项已确保存在 */
interface ForwarderConfig {
  forwardTo: string;
  forwardFrom: string;
  /** 未配置时跳过 Webhook 签名校验 */
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

/**
 * Webhook 负载的解析结果
 * received 需要转发；ignored 为不关心的事件类型；invalid 为负载缺必要字段
 */
type ParsedEvent =
  | { kind: 'received'; emailId: string }
  | { kind: 'ignored' }
  | { kind: 'invalid' };

/** 统一 JSON 响应格式，避免各分支重复构造 Header */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** 附件列表单次拉取上限，覆盖正常邮件的附件数量 */
const ATTACHMENT_LIST_LIMIT = 100;

/** 构造统一 JSON 响应；405 时按 HTTP 语义附带 allow 头 */
function jsonResponse(status: number, body: Record<string, unknown>): Response {
  const headers: Record<string, string> = { 'content-type': JSON_CONTENT_TYPE };
  if (status === 405) {
    headers.allow = 'POST';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/** 读取并校验环境变量，缺少必要项时返回 null，由调用方按 500 处理 */
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

/**
 * 解析 Webhook 负载，识别需要转发的收信事件
 * 只处理 email.received，其他事件类型按成功 ack，避免 Resend 无意义重试
 */
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

/**
 * 读取请求体并校验 Webhook 签名
 * 签名校验必须基于原始文本体，因此先读 text 再交给 SDK 校验
 * @param request - 原始请求
 * @param resend - Resend 客户端，复用其 Svix 签名校验实现
 * @param webhookSecret - 签名密钥，为 undefined 时跳过校验（仅限本地调试）
 * @returns 校验通过的事件，或可直接返回的错误响应
 */
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

/** 转义拼接进 HTML 元信息块的文本，防止原邮件内容破坏转发邮件的 HTML 结构 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 构造转发邮件的发送参数
 * replyTo 指向原始发件人，在目标邮箱直接回复即可回信给原作者
 * X-Original-* 头保留原始收发件信息，便于排查与设置过滤规则
 * @param email - 拉取到的完整邮件
 * @param config - 运行配置
 * @param attachments - 已下载的附件
 * @returns Resend 发信参数
 */
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

/**
 * 列出并下载邮件的全部附件
 * 任一附件失败即整体失败：宁可转发失败重试，也不发出丢失附件的不完整邮件
 * @param resend - Resend 客户端
 * @param emailId - 邮件 ID
 * @param attachmentCount - 附件数量，为 0 时跳过拉取
 * @returns 附件数组，失败返回 null
 */
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
  /**
   * html_format 取 cid：正文中内嵌图片以 content-id 引用
   * 对应二进制作为附件下发，随下方附件下载一并转发
   */
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

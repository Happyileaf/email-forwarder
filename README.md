# email-forwarder

极简邮件转发服务：接收 Resend Inbound Email 的 Webhook，将邮件完整转发到指定邮箱。

仅一个 Serverless Function，无数据库、无前端、无其他依赖服务。

## 项目用途

在 Resend 上配置域名收件（Receiving）后，发往该域名的邮件会通过 Webhook 推送到本服务；本服务拉取完整邮件（含 HTML / 纯文本 / 附件），并转发到 `FORWARD_TO` 指定的邮箱。

## 工作流程

1. Resend 收到邮件，推送 `email.received` Webhook 到 `POST /api/webhook`（只含元数据和 `email_id`）
2. Function 校验 Webhook 签名（配置 `RESEND_WEBHOOK_SECRET` 时，使用 Resend 官方 svix 校验）
3. 根据 `email_id` 调用 Resend API 拉取完整邮件
4. 下载全部附件（含 `cid` 内联图片）
5. 以 `FORWARD_FROM`（已验证域名邮箱）为发送身份，转发到 `FORWARD_TO`：
   - `Reply-To` 设置为原始发件人，在目标邮箱里直接回复即可回到原发件人
   - 主题添加 `Fwd: ` 前缀
   - 正文头部附加原始 From / To / Date / Subject 元信息
   - 附件原样转发
6. 返回 JSON 结果；返回 5xx 时 Resend 会自动重试 Webhook

## 本地开发

```bash
npm install
cp .env.example .env   # 填入配置
npx vercel dev
```

本地调试时不要配置 `RESEND_WEBHOOK_SECRET`（留空即跳过签名校验），然后用 curl 模拟 Webhook：

```bash
curl -X POST http://localhost:3000/api/webhook \
  -H 'content-type: application/json' \
  -d '{"type":"email.received","data":{"email_id":"<真实 email_id>"}}'
```

`email_id` 可在 Resend Dashboard 的 Receiving 记录中获取。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `RESEND_API_KEY` | 是 | Resend API Key，用于拉取和发送邮件 |
| `FORWARD_TO` | 是 | 转发目标邮箱 |
| `FORWARD_FROM` | 是 | 发送身份，必须是 Resend 已验证域名下的邮箱。不能直接冒充原始发件人：未验证的域会被 Resend 拒发，且容易被判为垃圾邮件 |
| `RESEND_WEBHOOK_SECRET` | 否 | Webhook 签名密钥。生产环境强烈建议配置；留空则跳过签名校验，仅限本地调试 |

## Vercel 部署

1. 将仓库导入 Vercel（或在仓库目录执行 `npx vercel`）
2. 在 Project Settings → Environment Variables 中配置上述环境变量
3. 部署后得到入口地址 `https://<project>.vercel.app/api/webhook`

`api/` 目录下的 TypeScript 文件会被 Vercel 自动识别为 Serverless Function（Node.js 运行时），无需额外配置。

## Resend Webhook 配置

1. Resend Dashboard → Domains：验证发件域名（`FORWARD_FROM` 所在域）
2. Dashboard → Receiving：按指引为收件域名配置 MX 记录
3. Dashboard → Webhooks：新增 Endpoint，URL 填 `https://<project>.vercel.app/api/webhook`，订阅 `email.received`
4. 复制该 Endpoint 的 Signing Secret，配置为环境变量 `RESEND_WEBHOOK_SECRET`

## 如何测试

```bash
npm run typecheck   # TypeScript 类型检查
npm test            # node:test 单元测试（mock Resend，无需真实账号）
```

端到端验证：向已配置 Receiving 的域名邮箱真实发一封邮件，确认 `FORWARD_TO` 收到转发，并在 Vercel 日志与 Resend Webhook 投递记录中核对结果。

## 已知限制

- **重复 Webhook**：以 `email_id` 作为 Resend 幂等键，24 小时内的重复投递不会重复转发；超过 24 小时的重复投递无法识别（引入存储会明显增加复杂度，暂不支持）
- **附件大小**：附件需下载到内存再转发，受 Serverless 内存与执行时长（30 秒）限制，超大附件可能失败；失败返回 502，由 Resend 重试
- **正文缺失**：个别邮件只有 HTML 或只有纯文本，按实际内容转发；两者都缺失时仅转发元信息
- **原始主题不放入自定义 Header**：为避免非 ASCII 字符的 Header 编码问题，原始主题只保留在 `Fwd:` 主题与正文元信息中

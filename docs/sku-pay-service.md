# 发布 SKU 按次核验服务

SKU 核验定价为 **¥0.99／次完整核验任务**，通过支付宝 Machine Pay（其官方产品名为“AI 按量付费”）收款。用户价格不随内部模型 token、搜索次数或运行时长变化。用户在自己的 Agent 中安装 `sku-verifier`，确认账单后付款，再同步取得核验报告。原 Grill My Research 的 ¥9.90 买断商品使用另一条发布流程。

本文记录的是待上线的服务接入流程。2026-11-06 已切换公司火山账号，建立独立的 SKU 网关服务和 Supabase 工作区。数据库直连、受限账号读写及权限隔离已验证；支付宝服务已注册，尚未发布付费函数或完成商户应用配置和真实支付验收。原有 veFaaS IAM 调用成功不等于消费者付费链路通过。

## 准备服务配置

1. 准备 PostgreSQL 数据库。付费入口使用数据库原子领取订单执行资格，并保存报告用于重复领取。实例内存和云函数临时目录不能代替数据库。
2. 以管理员身份在事务中创建私有 `sku_paid` schema，设置 `SET LOCAL search_path=sku_paid,pg_catalog`，依次执行 `migrations/001-paid-orders.sql` 和 `paid/provision-postgres.sql` 后提交。后者创建初始为 `NOLOGIN` 的受限 `sku_paid_runtime` 角色，启用并强制 RLS。另行在安全的管理进程中设置该角色的登录密码。服务使用其连接串，迁移使用管理员身份；禁止向消费者提供数据库凭据。
3. 在本地受 Git 忽略的环境文件中配置 `DATABASE_URL`、`DEEPSEEK_API_KEY`、`ALIPAY_ENVIRONMENT`、`ALIPAY_APP_ID`、`ALIPAY_SERVICE_ID`、`ALIPAY_PRIVATE_KEY` 和 `ALIPAY_PUBLIC_KEY`。以服务目录的环境示例和启动校验为准。不要将私钥或连接密码粘贴到聊天、命令行参数或 Skill 包。
4. 设置 `SKU_PRICE_FEN=99`。支付宝注册的服务单价必须为 `0.99`。订单创建后金额固定，后续改价不改变既有订单。

支付宝沙箱和生产使用不同的网关与密钥。完成本地测试后，再用官方沙箱配置验证签名、预下单和凭证核验；本地模拟支付不能代替沙箱验收。

## 发布公开入口

1. 为付费入口单独发布 veFaaS 函数，保留现有内部 IAM 核验入口。
2. 在公司账号现有 `serverless-default` 网关中使用独立服务 `sku-verifier-paid`，通过 HTTPS 暴露 `POST /v1/verify` 和 `GET /v1/orders/:orderId`。网关服务域名已分配，尚未绑定付费函数，不能作为可用 API 对外发布。
3. 确认网关透传 `Authorization`、`Payment-Proof` 和 `amtPaymentLink`。按核验执行上限配置超时，并为新订单配置并验证限流。当前代码没有跨实例报价限流，未验证网关限制前不得开放公开收费。恢复已有订单应保持可用。
4. 从外部网络验证未付款请求只产生账单，不执行 DeepSeek；无效凭证、错金额和错订单均不交付报告。

火山官方说明中，网关触发器与函数同时配置超时时取较小值，关闭触发器超时开关则该触发器不限制等待时长。仍须验证实际公开入口的完整请求链路，不能只检查函数配置。[API 网关触发器文档](https://www.volcengine.com/docs/6662/116904)

## 已准备的公司资源

- 公司账号 `2101142542`，地域 `cn-beijing`。
- 网关 `gd77mqoj2f3srdqla2ndg`，独立服务 `sjqejd27h19fslccuqorl`。
- 已分配域名 `https://sjqejd27h19fslccuqorl.apigateway-cn-beijing.volceapi.com`，尚未接入付费路由。
- 独立 Supabase 工作区 `sku-verifier`，ID `vivid-bluet-63e5e1dt`，默认分支 `br-grand-skua-6a9d0aaf`。没有复用现有 GEO 数据库。
- 空闲 3600 秒后自动休眠已配置并回读确认，下次访问由平台唤醒。冷启动行为尚待公开接口验收。
- `sku_paid.paid_orders` 强制 RLS；运行账号仅有该表 SELECT、INSERT、UPDATE 权限，无 DELETE 和 schema CREATE 权限。真实 TLS 连接使用证书校验，验证数据已回滚。

数据库连接信息通过官方 `DescribeSupabaseDeployEnvVars` 取得并保存在本地受忽略文件中。通用 `db connection-string` 所调用的 `DescribeDBAccountConnection` 在此次环境返回权限错误，不能据此判断 Supabase 直连不可用。

## 注册支付宝服务

在[AI 按量付费接入页](https://aipay.alipay.com/open-flow/products?product=metered)选择页面引导，完成技术集成、产品开通、服务注册、密钥配置与线上验证。

注册时填写：

| 字段 | 值 |
| --- | --- |
| 服务类型 | API |
| 服务名称 | SKU 规格与事实核验 |
| 服务地址 | 实际已验证的 HTTPS 入口 `/v1/verify` |
| 服务单价 | 0.99 元／次 |
| 服务描述 | 输入品牌、品名、净含量及可选包装或版本，检索公开来源，核对 SKU 与事实，返回包含原文证据的报告；缺失和冲突如实标明 |

当前已注册服务 ID 为 `API_F6D557EB35C24739`，单价为 ¥0.99；密钥配置页等待商户阅读协议并创建应用。取得应用配置后，将该服务 ID 写入生产服务配置。应用私钥只留在服务端，消费者通过自己的支付宝支付能力取得凭证。

2026-11-06 核对的最新接口使用 `alipay.aipay.agent.payment.precreate` 生成预下单号，经 HTTP 402 的 `amtPaymentLink` 响应头交给调用方。用户付款后，请求携带 `Payment-Proof`，服务端调用 `alipay.aipay.agent.payment.verify` 并验证支付宝响应签名、订单号、交易号、金额和 `active`。SKU 与本地订单绑定，不依赖已废弃的 `resource_id`。[接入指南](https://aipay.alipay.com/docs/ai-receive/MACHINE_PAY.html)、[预下单接口](https://aipay.alipay.com/docs/ai-receive/api-list/alipay-aipay-agent-payment-precreate.html)、[凭证核验接口](https://aipay.alipay.com/docs/ai-receive/api-list/alipay-aipay-agent-payment-verify.html)

## 安装并验证消费者 Skill

将 `skills/sku-verifier/` 整个目录安装到 Agent 的技能目录，按 [Skill 入口](../skills/sku-verifier/SKILL.md)使用。Node.js 20.19+ 客户端只需要公开服务地址，不需要商户、数据库、火山或 DeepSeek 密钥。

```sh
mkdir -p "$HOME/.local/share/sku-verifier"
node skills/sku-verifier/scripts/client.mjs quote \
  skills/sku-verifier/examples/jasmine-tea-500ml.json \
  "$HOME/.local/share/sku-verifier/jasmine-001" --endpoint https://your-verified-service.example
```

将示例地址替换为实际公开入口。客户端先保存私有订单凭据，再请求报价。Agent 展示 ¥0.99 账单，经用户确认后调用其已安装的官方支付宝支付能力。付款完成后将 `Payment-Proof` 通过标准输入交给 `execute`，不要放入命令行参数或日志。

```sh
node skills/sku-verifier/scripts/client.mjs execute "$HOME/.local/share/sku-verifier/jasmine-001" --proof-stdin
node skills/sku-verifier/scripts/client.mjs recover "$HOME/.local/share/sku-verifier/jasmine-001"
```

命令中的 `skills/sku-verifier` 应替换为实际安装目录。订单目录须位于仓库和共享目录之外。

`recover` 只读取原订单，不能重新付款或重新核验。首次报价响应丢失时，可显式运行 `quote-again <原订单目录>`，它使用同一订单和身份，不带支付凭证，不启动研究。保管订单目录中的私有凭据；持有凭据的人可以领取该订单报告。

正式发布前，用同一个订单完成报价、付款、同步交付，再模拟丢失响应后领取。确认只执行一次研究，并记录公开入口、代码版本、测试结果和报告摘要。真实付款需要买家确认，不能把模拟测试写成真实交易通过。

## 处理失败订单

核验完成可能没有找到匹配规格，或部分事实缺失。这是报告内容的一部分，不能将其描述为保证核验成功。

模型失败、预算耗尽和进程中断需要分别说明。客户端不得遇到错误便创建新订单并再次收费。执行结果不确定时，保留原订单交由服务方处理。上线前配置可用的客服渠道和补偿流程；本实现不自动执行退款。

订单记录用于阻止重复执行。不要删除唯一的已付款订单后允许旧请求重新运行。生产运营需要确定报告保留期限、过期处理和最小订单记录的保留策略，再向买家公布，不能承诺永久保存报告。

## 验证记录

本地消费者 HTTP 入口已接入真实 DeepSeek 与隔离 PostgreSQL，东方树叶茉莉花茶 500ml 完成报价、执行、保存及同订单恢复，研究只执行一次。此次取得 9 个来源，其中 2 个不同域名支持东方树叶、茉莉花茶和 500 mL；官方精确规格仍缺少证据。支付使用测试适配器，没有真实扣款，因此不代表支付宝沙箱或生产支付验收通过。摘要见[本地付费链路记录](../services/sku-verifier/evals/2026-11-06-paid-local-jasmine.json)。

完整测试范围、独立复核及上线门槛见[接入验证记录](sku-pay-verification.md)。

# Pay Skill 买断交付草案

购买者一次付款，取得当前版本完整安装包的永久使用权。安装后，由购买者自己的 Agent 加载技能、澄清研究需求并生成 Deep Research 提示词。研究内容和模型调用都留在购买者所选的 Agent 环境中。

## 首次购买

SkillHub 官方将 Pay Skill 描述为按调用收费。对本项目，拟把一次付费调用定义为购买并交付完整技能包。平台已有商家描述一次付费、后续不限次数使用，具体交付方式仍需在本项目的审核和联调中确认。[SkillPay 官方说明](https://www.skillhub.cn/skillpay) · [已上架商品示例](https://skillhub.cn/skills/bundle-legal-tools)

SkillHub 上的入口包负责发起购买。一个小型 HTTPS 服务验证付款、记录订单与购买权益，并交付对应版本的 ZIP。支付重试或恢复交付应取回同一笔购买的结果。验收时覆盖未付款、重复请求、已付款但下载中断，以及安装后多次使用均无收费调用的情况。

当前 GitHub 仓库公开，完整 skill 可直接从源码安装。如果要销售独家内容，需要先明确公开版本与付费交付物的区别。发布时还需确定买断价、托管位置和已购用户重新下载的方式。后续版本的升级权益可单独说明。

## 协议核对记录（2026-11-03）

当前官方材料存在版本差异：

- [SkillHub 指南](https://skillhub.cn/tutorials#alipay-pay) 与支付宝官方 npm 包 `@alipay/alipay-aipay@1.8.0` 的 `aipay-interface-contract.md` 使用 `Payment-Needed` 账单、`Payment-Proof`、验付和履约确认。
- [支付宝在线接入指南](https://aipay.alipay.com/docs/ai-receive/MACHINE_PAY.html) 使用 `alipay.aipay.agent.payment.precreate` 创建预下单，并返回 `amtPaymentLink`。
- [最新验付接口](https://aipay.alipay.com/docs/ai-receive/api-list/alipay-aipay-agent-payment-verify.html) 标注 `resource_id` 已废弃，而 npm 包示例仍要求校验该字段。

接入前需通过官方沙箱与 SkillHub 买家调用链确认适用协议。不能把两套协议字段随意拼接，也不能因字段缺失跳过金额与订单绑定检查。当前仅下载阅读官方包，未执行其安装、遥测或账户操作。

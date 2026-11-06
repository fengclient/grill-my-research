# SKU Verifier

面向预包装食品和饮料的 SKU 核验服务，提供从精确商品输入、搜索、正文获取到证据检查及 JSON/Markdown 报告的本地任务入口，以及 veFaaS 同步 HTTP 入口。云端核验完成后直接返回报告，由调用方保存。部署、调用和超时处理见 [云端部署说明](cloud/README.md)。

## 本地运行

使用 Node.js 20.19+，通过运行环境提供 `DEEPSEEK_API_KEY`。服务没有第三方运行依赖。在本目录执行：

```sh
npm ci --ignore-scripts
npm test
npm run search -- '无糖茶 330mL 包装规格'
npm run fetch -- 'https://example.com/product'
```

CLI 输出 JSON，包含提供方原始结果、调用统计和估算费用。命令行入口每次最多发起 3 次请求（含重试）。本地开发可以使用 `node --env-file=.env src/cli.mjs search '查询词'` 加载自行配置的环境文件，`.env` 已被 Git 忽略。

若密钥统一放在 `services/.env`，在本目录使用下列命令加载：

```sh
node --env-file=../.env src/cli.mjs search '查询词'
node --env-file=../.env src/cli.mjs fetch 'https://example.com/product'
node --env-file=../.env src/cli.mjs verify examples/jasmine-tea-500ml.json runs/jasmine-first-run
```

`verify` 的输出目录必须是新目录。命令写入 `report.json` 和 `report.md`，前者包含来源正文、获取时间、内容摘要、执行轨迹和用量，后者供阅读。`runs/` 已被 Git 忽略。重复执行请指定新目录，既有目录会在调用 API 前被拒绝。失败或预算耗尽时，命令返回非零退出码并保存失败状态与已取得来源。

## Agent 与核验规则

运行器使用 Node.js，默认模型为 `deepseek-flash`，可通过 `DEEPSEEK_MODEL` 配置。模型以 JSON 动作选择 `search`、`fetch` 或 `finish`，运行器执行动作并保存轨迹。默认每项任务最多 8 次模型调用、12 次 Search/Fetch 请求（含重试），一个来源向模型展示的正文最多 8,000 字符。更长页面会标记截断。

模型选择正文行号，程序从已取得的正文提取原文。每个证据上下文必须同时包含目标品牌、品名和净含量；0.5 L 与 500 mL 可以匹配，混合容量、范围筛选值和未匹配的包装／版本会被拒绝。事实行必须位于该产品上下文内。当前按字面匹配品牌与品名，语言或名称别名需要在后续身份模型中处理。

报告区分配料、营养、保质期、储存条件、生产商、来源声明和渠道报价原文。缺证据的字段显示缺失，多种来源表述并列供复核。报价保留来源上下文，数值单位价格计算待后续增加。官方来源由输入中的 `officialDomains` 匹配域名判定，页面标题中的“官方旗舰店”不会改变来源类型。

示例输入只指定东方树叶、茉莉花茶和 500 mL，包装形式及版本为未知。`requested_identity_supported` 表示取得了匹配这些请求条件的原文。报告同时列出尚未指定的身份维度、官方精确规格证据及图片复核缺口。

模型输出为空、截断或无效 JSON 时任务失败；模型调用采用单次请求，运行器记录 token 用量。Search/Fetch 费用与模型 token 分开统计，模型费用按实际调用时段和账户账单核算。

## 服务内调用

```js
import { DeepSeekClient } from './src/deepseek.mjs';

// 每项任务建立一个客户端。调用预算由上层任务明确指定，含重试次数。
const search = new DeepSeekClient({ maxRequests: 15 });
const results = await search.search('品牌 商品名 330mL', { count: 5 });
// results.results 保留 URL、标题、摘要、正文、发布时间与提供方排序信息。
// 检查 content 的缺口后，对选中的来源调用 search.fetch(url) 补查。
console.log(results, search.usage);
```

Search 默认 `needContent: true`。可选参数包括 `count`、`needContent`、`originalQuestion`、`localization` 和 `signal`；Fetch 接收 URL 与可选 `signal`。调用预算由一个客户端内所有 Search/Fetch 共用，在进程内同步预留，超出后返回 `REQUEST_BUDGET_EXCEEDED`。

该预算适用于当前任务客户端。同步云端入口每次请求独立执行，调用方断连后不自动重试，没有跨实例幂等和事后结果恢复。账户总开支上限仍需单独管理。客户端返回提供方内容，上层核验服务把网页正文视为证据数据，逐条匹配 SKU 身份并记录获取时间。

## 错误与计费

- 每次请求默认超时 30 秒，网络错误、超时和 HTTP 408／429／5xx 最多重试 2 次。遵守 `Retry-After`，超过 30 秒的退避交由上层调度。其他 4xx 直接返回错误。
- `DeepSeekError` 提供 `code`、`status`、`retryable`，错误消息使用固定文本。DeepSeek 余额不足返回 HTTP 402，应由服务端处理为提供方故障。
- `successfulResponses` 统计已解析的有效响应。`billableResponses` 统计有结果的成功响应，空 Search 和空 Fetch 正文不增加估算费用。
- `uncertainOutcomes` 记录断连、超时或成功响应无法解析的次数。此时提供方可能已经完成请求，估算费用只覆盖明确观察到的计费响应，应以账户账单为准。
- 按 2026-11-04 查阅的官方价格，Search 和 Fetch 均为 ¥5／千次成功且有结果的请求。实际价格变化时更新客户端中的 `PRICING`。

自动化测试使用本地响应替身，覆盖请求契约、结果保留、输入校验、失败重试、预算、超时取消与命令行错误入口。

## 真实接口联调

2026-11-04 使用“农夫山泉 东方树叶 茉莉花茶 500ml 官网 配料”完成一次 Search，得到 10 条结果，包含官方页面、食品产品库与零售页。随后对命中的[农夫山泉官方页面](https://www.nongfuspring.com/goods/detail-all.html?id=1)完成一次 Fetch，得到 1,623 个字符的正文。两个成功请求各执行 1 次，按当日公开单价合计估算 ¥0.01。

搜索结果包含多个规格、地区和组合包装。后续核验流程需要分别判断商品身份、适用地区、版本及报价条件，并将每项事实关联到具体来源。本次联调记录 Search/Fetch 的真实连通性与正文获取结果。

## 后续集成

完整任务的真实验证摘要见 [东方树叶案例记录](evals/2026-11-04-jasmine.json)。该记录保留使用量、来源 URL、正文摘要和代码摘要，完整网页快照及报告保存在本地运行目录。

2026-11-06 在个人账号的 veFaaS 同步函数上完成真实验证，约 11.4 秒直接返回 HTTP 200 和完整报告；2 个不同域名来源支持请求规格。Search 已返回正文，因此本轮只执行 2 次 Search，没有另发 Fetch 请求，检索费用估算 ¥0.01，不含模型及云函数费用。配料和储存条件的不同表述并列保留，官方精确规格、生产商与报价仍有缺口。引文、来源摘要和云端回拉代码的逐字节检查通过，记录见 [云端案例](evals/2026-11-06-cloud-jasmine.json)。

veFaaS 入口在一次同步请求内完成核验，直接返回 JSON 或 Markdown；运行权限由平台 IAM 和服务 token 控制。调用方负责保存结果，支付、消费者鉴权和账户总预算尚未接入。

官方契约见 [Search API](https://api-docs.deepseek.com/zh-cn/api/search/)、[Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch/) 与[错误处理及计费指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。

模型接口依据 [JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/) 与 [Chat Completions](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)。

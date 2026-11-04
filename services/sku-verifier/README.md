# SKU Verifier

面向预包装食品和饮料的 SKU 核验服务，计划部署到火山引擎 veFaaS。当前完成 DeepSeek Search/Fetch 客户端和命令行入口，可以搜索并获取页面正文。

## 本地运行

使用 Node.js 22+，通过运行环境提供 `DEEPSEEK_API_KEY`。客户端没有第三方运行依赖。在本目录执行：

```sh
npm test
npm run search -- '无糖茶 330mL 包装规格'
npm run fetch -- 'https://example.com/product'
```

CLI 输出 JSON，包含提供方原始结果、调用统计和估算费用。命令行入口每次最多发起 3 次请求（含重试）。本地开发可以使用 `node --env-file=.env src/cli.mjs search '查询词'` 加载自行配置的环境文件，`.env` 已被 Git 忽略。

若密钥统一放在 `services/.env`，在本目录使用下列命令加载：

```sh
node --env-file=../.env src/cli.mjs search '查询词'
node --env-file=../.env src/cli.mjs fetch 'https://example.com/product'
```

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

该预算适用于当前任务客户端。多实例执行、任务重启与实际账户开支上限，需要后续任务存储统一管理。客户端返回提供方内容，上层核验服务须把网页正文视为证据数据，逐条匹配 SKU 身份并记录获取时间。

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

下一阶段将客户端接入“精确 SKU 输入 → 搜索与原文获取 → 身份及事实核验 → 带证据报告”的任务流程，再增加 veFaaS 异步执行、持久化恢复、支付和交付。

官方契约见 [Search API](https://api-docs.deepseek.com/zh-cn/api/search/)、[Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch/) 与[错误处理及计费指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。

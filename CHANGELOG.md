# Changelog

按 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 记录面向使用者的变化，版本遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

- 增加 SKU 核验 Agent、正文行号证据提取、规格匹配与事实覆盖检查、JSON/Markdown 报告，以及东方树叶茉莉花茶 500 mL 的完整任务联调记录。

- 新增 `services/sku-verifier/`，实现 DeepSeek Search/Fetch 客户端、调用量与估算费用统计、重试与请求预算，以及命令行入口和接口测试。

- 补充支付宝 SkillPay 购买入口与商品更新流程。下方 0.1.0 记录的是打包时的状态；该版本随后于 2026-11-03 通过支付宝 SkillPay 审核，以 ¥9.90 买断价上架。

## [0.1.0] - 2026-11-03

### Added

- 通用 Deep Research 提示词创作流程，支持关键澄清、直接出稿和完整改写。
- 六类场景、三个模型的行为评测，包含独立盲评、负向对照和证据检查。
- 统一版本文件、发布流程，以及仅包含技能运行文件的可复现 ZIP 包和 SHA-256 摘要。

### Release status

- 此版本是现有提示词技能的源码基线，尚未接入支付宝收费 API，也未作为 Pay Skill 上架。

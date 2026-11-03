# 从 dt-my-research 迁移的设计

本次提炼基于 `dt-my-research` 工作区内的 `fnb-research-import` skill（入口元数据版本 `0.12.0`）。迁移的是提示词创作模式；原工作区未被修改，研究数据、客户材料和运行记录未复制到本仓库。

本仓库的技能入口为 [skills/grill-my-research/SKILL.md](../skills/grill-my-research/SKILL.md)。该目录包含运行所需的全部技能文件，可独立安装；仓库根目录的 README 和本迁移说明不属于技能安装包。

## 来源定位

以下路径相对于源工作区，供维护者追溯，不是新 skill 的运行时依赖：

- `.agents/skills/fnb-research-import/SKILL.md`
- `.agents/skills/fnb-research-import/references/shared/research-brief.md`
- `.agents/skills/fnb-research-import/references/shared/research-prompt-rationale.md`
- `.agents/skills/fnb-research-import/references/food/deep-research-prompt.md`
- `.agents/skills/fnb-research-import/scripts/build-research-prompt.mjs`
- `.agents/skills/fnb-research-import/assets/research-presets.json`

## 保留与泛化

| 原模式 | 新项目中的处理 |
| --- | --- |
| 目标上下文 + 分类／排除／必含名称／规格四维 | 不再作为输入框架；围绕研究问题和用途澄清，具体维度仅在任务需要时产生 |
| 可选消费者需求分组 | 不保留为独立步骤；研究者可按问题提出有帮助的分析角度 |
| 逐步补齐输入，保留部分答案 | 保留；优先解决高影响歧义，不固定轮数，不重复已答项 |
| 用户定稿后执行外部研究 | 输入充分即可交付提示词；不把生成提示词附加成执行授权或审批流程 |
| 候选召回优先、先广后窄 | 保留为格局扫描策略；其他任务按比较、检验或解释目标选择方法 |
| 名单是最低覆盖、示例不是硬条件 | 保留尊重用户边界的原则，不默认收集名单 |
| 明确空值与历史未知不同 | 不迁入数据状态协议；用自然语言区分已知条件与工作假设 |
| 原值、单位、期间、版本与来源 | 具体口径仅在相关任务中补充；通用要求聚焦证据可追溯和推断有依据 |
| 已取得／未取得／冲突／未检查 | 移除固定状态与矩阵，按实际任务说明资料限制和不确定性 |
| 固定市场／产品线／SKU 输出 | 改为按用途设计章节和比较字段，不强制领域表格 |

## 未迁入的部分

- 食品／饮料限定、茶饮和方便面预设、中国大陆／CNY／最近三年默认值。
- 品牌梯队、SKU、产品线销售额与价格轴的专属规则及运行时 Schema。
- Kimi 浏览器提交、轮询、全文回收、研究过程归档及恢复检查点。
- `market-map-cli` 导入、地图、商品核验和幻灯片交付。
- 原生成脚本：它依赖领域 Schema、字段映射和导入规则；通用版由 Agent 根据 Brief 编写提示词，当前无需确定性编译脚本。

## 当前设计依据

2026-10-30 查阅以下官方资料后，将初版偏重字段与规格的流程进一步收敛为研究对话与提示词写作：

- [OpenAI：Deep research in ChatGPT](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt) 强调问题、期望成果和相关约束。本项目据此把它们作为澄清重点，不将固定分类或字段当成前置条件。
- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) 建议提供足以指导行为的清晰信息，避免过细、脆弱的规则，也避免空泛指令。本项目采用按需增加细节、少量示例和交付前删减的做法。
- [Anthropic：How we built our multi-agent research system](https://www.anthropic.com/research/multi-agent-research-system) 指出开放研究需要根据发现调整路径。本项目只借鉴明确目标、边界并保留方法灵活性的原则，不要求多代理、固定调用次数或厂商专用流程。

这些资料提供设计指导，不构成一套唯一的最佳提示词格式，也不证明本 skill 的效果。取消默认四维输入、按信息充分程度结束追问、默认仅交付提示词，是结合本项目用途作出的设计选择。结构校验确认包装有效；[行为评测](../evals/README.md) 使用真实模型响应、独立盲评和工具记录检查提示词创作行为，实际研究质量仍需真实任务验证。

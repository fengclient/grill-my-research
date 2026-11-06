# grill-my-research

通过有针对性的追问，把模糊的研究想法变成可直接交给 Deep Research 工具执行的提示词。

适用于市场扫描、技术选型、学术综述、历史研究、政策比较、产品策略等主题。它帮助你明确研究要回答什么、哪些证据能回答、什么结果才算有用；默认交付提示词，不自动发起外部研究。

[在支付宝 SkillPay 购买 Grill My Research](https://skillpay.alipay.com/user/product?merchantId=2088702084897672&productId=P0806000211847585)。**¥9.90 一次买断**，付款后获得完整 Skill，可在自己的 Agent 中永久使用所购版本，生成或改写提示词不限次数。

## SKU 核验服务

本仓库同时开发面向预包装食品和饮料的 SKU 核验服务，使用 DeepSeek 模型与 Search/Fetch 执行“精确 SKU 输入 → Agent 检索 → 原文与规格检查 → JSON/Markdown 报告”。支持本地任务和 veFaaS 同步调用。运行步骤与真实案例见 [SKU Verifier](services/sku-verifier/README.md)。

独立的 [sku-verifier Skill](skills/sku-verifier/SKILL.md) 将这项服务提供给用户自己的 Agent，定价 **¥0.99／次核验任务**，通过支付宝 Machine Pay（AI 按量付费）付款。付款购买一次检索和证据核验，不保证找到精确 SKU 或所有字段。重复领取同一订单的报告不再次执行核验。

当前已注册 ¥0.99 的支付宝服务，并在公司火山账号创建独立 Supabase 和网关服务。商户应用密钥、付费函数发布及真实支付验收尚未完成，暂不可供消费者使用。接入流程与验证状态见[按次服务发布说明](docs/sku-pay-service.md)。它与上面的 ¥9.90 提示词 Skill 买断商品分开销售。

## 使用方式

在能够读取本仓库文件的 Agent 中输入：

```text
请读取本仓库的 skills/grill-my-research/SKILL.md，使用 grill-my-research：
我想研究开源知识库的技术选型，用于一个 20 人的研发团队。
先帮我找出问题中的盲点，再生成 Deep Research 提示词。
```

安装为 Codex skill 后，也可以使用：

```text
$grill-my-research 我想了解远程办公是否影响研发团队的创新能力。
```

提供已有提示词可以直接改写；提供充分背景可以直接生成。想省去访谈，可以明确说“先按合理假设出一版，并标明假设”；想深入梳理，可以说“逐个追问，直到研究问题清楚”。

## 工作方式

1. **明确用途**：研究服务于什么决策、解释或学习目标，谁会阅读结果。
2. **追问关键歧义**：识别预设结论、范围冲突和不可执行要求，优先解决会改变研究方向的问题。
3. **形成清楚的研究任务**：整理必要背景、关键问题和真正影响结果的约束。
4. **生成完整提示词**：说明期望成果与证据要求，让研究工具能独立执行并根据发现调整研究路径。

不设固定问卷，也不默认约定规格、字段、分类、来源数量或搜索预算。研究方法和所需细节由问题自然产生；用户已经给出的具体要求会完整保留。只要信息足以生成有用的提示词，就结束追问。

## 交付内容

- 一份可复制的完整 Deep Research 提示词，写清问题、必要背景、重要约束和期望成果。
- 存在重要假设或设计取舍时，附简短说明；不强制另交 Brief 或检查表。

“完整”意味着另一位研究者不依赖本次聊天也能理解任务，不意味着提示词越长越好。当前设计参考了官方关于问题、成果与约束的指导，以及清晰而不过度规定流程的原则，具体来源见[设计依据](docs/migration.md#当前设计依据)。

输出不绑定某个平台的按钮、API 或报告格式；实际联网、附件、数据库访问和执行时长取决于所使用的工具。无浏览能力时，提示词要求如实报告限制，不声称完成了检索。

## 安装到 Codex

Skill 位于 `skills/grill-my-research/`，无运行时依赖。在仓库根目录执行下列命令，将整个 skill 目录的内容复制到个人技能目录；如果已有同名 skill，命令会停止，以免覆盖：

```sh
skill_parent="${CODEX_HOME:-$HOME/.codex}/skills"
skill_target="$skill_parent/grill-my-research"
mkdir -p "$skill_parent"
if mkdir "$skill_target"; then
  cp -R skills/grill-my-research/. "$skill_target/"
fi
```

重新开启会话后使用 `$grill-my-research`。也可以不安装，直接要求 Agent 读取仓库中的 `skills/grill-my-research/SKILL.md`。

## 评测

[行为评测流程](evals/README.md) 包含六类请求、五项语义标准、独立盲评和负向对照。模糊目标案例覆盖澄清后继续生成的两轮对话。案例、评分规则和执行记录保留在仓库中，不随 skill 安装。

本次运行、失败修复与覆盖限制见 [2026-11-02 评测报告](evals/results/2026-11-02/report.md)。

检查已保存的执行证据：

```sh
python3 scripts/check-evals.py evals/results/2026-11-02
```

该命令检查结果完整性、文件摘要和独立评审结论，不会重新调用模型。重新运行模型需按评测流程创建新会话。通过这些案例只说明本次抽样行为符合要求，不证明后续研究结论正确。

## 版本与发布

提示词 Skill 的版本号以 [VERSION](VERSION) 为准，变化记录在 [CHANGELOG.md](CHANGELOG.md)。它使用 SemVer、带注释的 `vX.Y.Z` 标签和 GitHub Releases；发布包只包含 skill 文件，并附 SHA-256 摘要。SKU Skill 使用自己的 [VERSION](skills/sku-verifier/VERSION) 和独立发布包。

```sh
python3 scripts/build-release.py --evals evals/results/2026-11-02
```

打包与版本管理见[发布说明](docs/releasing.md)，支付宝商品更新步骤见 [SkillPay 发布指南](docs/pay-service.md)。

## 项目文件

仓库文档与可独立安装的 skill 分开维护：

```text
grill-my-research/
├── README.md
├── VERSION
├── CHANGELOG.md
├── skills/
│   ├── grill-my-research/   # 提示词创作 Skill
│   └── sku-verifier/        # 按次核验 Skill、客户端与独立版本
├── services/sku-verifier/   # 研究运行器、内部入口、付费入口与订单迁移
├── docs/                   # 迁移、安装、两种付费模式的发布说明
├── evals/                  # 提示词 Skill 行为评测
├── scripts/                # 评测检查和两个 Skill 的独立打包脚本
└── tests/                  # 消费者客户端与 SKU 发布包测试
```

| 文件 | 用途 |
| --- | --- |
| [SKILL.md](skills/grill-my-research/SKILL.md) | Skill 入口、追问原则和生成流程 |
| [research-brief.md](skills/grill-my-research/references/research-brief.md) | 研究对话与适时结束追问的方法 |
| [prompt-template.md](skills/grill-my-research/references/prompt-template.md) | 可裁剪的提示词骨架与交付检查 |
| [examples.md](skills/grill-my-research/references/examples.md) | 历史理解、技术选择完整示例及跨领域行为案例 |
| [docs/migration.md](docs/migration.md) | 原模式的来源、保留项和泛化取舍 |
| [openai.yaml](skills/grill-my-research/agents/openai.yaml) | Codex 展示信息和默认调用示例 |

`grill-my-research` skill 从 `dt-my-research` 的研究提示词工作流提炼而来，移除了食品／饮料专属数据契约、Kimi 自动执行及市场地图导入流程。其行为评测执行提示词创作；SKU 服务的检索接口测试在服务目录运行。

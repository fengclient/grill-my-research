# 版本与发布

本仓库目前只有一个 skill，使用一个版本序列。`VERSION` 是版本号的唯一来源；标签、发布包名和 SkillHub 表单必须使用同一个数字版本，Git 标签加 `v` 前缀。当前源码版本为 `0.1.0`，尚未完成 Pay Skill 接入。

## 版本约定

按 `MAJOR.MINOR.PATCH` 判断使用者是否需要调整用法：

- 修复错误或不改变行为的文字改进，增加 PATCH。
- 保留已有调用方式并增加能力，增加 MINOR。
- 改变默认交付、收费要求、必需依赖或不兼容的输入输出，稳定版增加 MAJOR。

`0.x` 表示接口仍在开发，破坏性变化增加 MINOR 并写清迁移方法。初次稳定发布使用 `1.0.0`。当前工具只打包正式数字版本；暂不引入自动发版服务或多包版本协调。

Agent Skills 规范允许在 `metadata` 中放版本，但未要求统一版本字段。本项目把版本放在发布层，避免为每次发版改动模型指令。安装来源可通过版本标签、ZIP 文件名和平台版本确认；技能目录不再维护第二份版本号。

## 准备发布

1. 修改 `VERSION`，在 `CHANGELOG.md` 增加对应日期与变化，说明兼容性和迁移要求。
2. 技能文件有变化时，按 [评测流程](../evals/README.md) 生成新结果。只改仓库发布文档或版本文件，且技能目录字节未变时，可以沿用已有行为证据；不得重写旧摘要假装重测。
3. 使用 Python 3.9+ 在仓库根目录打包：

   ```sh
   python3 scripts/build-release.py --evals evals/results/2026-11-02
   python3 scripts/test-evals.py
   python3 scripts/test-release.py
   ```

   后续版本将 `--evals` 换为对应结果目录。脚本验证版本、变更记录和现有评测证据；ZIP 根目录是 `SKILL.md`，仅打包 `skills/grill-my-research/`。固定 ZIP 时间戳和权限，相同输入生成相同字节。`dist/` 不入 Git，不包含仓库文档、评测记录或本地状态。

4. 检查 ZIP、摘要和生成的发布说明，再提交版本变化。发布脚本自测覆盖可重复构建、包内容与摘要，以及无效版本、缺少变更记录、技能改动、额外文件、符号链接和同版本资产冲突。
5. 将带注释的版本标签推送到提交，创建对应 GitHub Release，附上 ZIP、SHA-256 和发布说明。已发布的标签与资产不覆盖；有错误则发新版本。仓库压缩包不是可直接上传的 skill 包。

以下是交互式终端示例；若工作区使用 direnv，先确保自己的终端 hook 已加载正确身份。自动化执行应按实际工作区配置使用 `direnv exec`，不要写死个人路径。

```sh
release_version="$(cat VERSION)"
git tag -a "v$release_version" -m "Release v$release_version"
git push origin main "v$release_version"
gh release create "v$release_version" \
  "dist/grill-my-research-$release_version.zip" \
  "dist/grill-my-research-$release_version.zip.sha256" \
  --verify-tag --title "v$release_version" \
  --notes-file "dist/grill-my-research-$release_version.zip.notes.md"
```

先确认工作区干净、标签对应预期提交。重复执行时先查看远端标签与 Release；不要强制移动标签，也不要用覆盖参数替换已发布资产。

## Pay Skill 发布条件

版本机制不等于支付接入。根据 [SkillHub 个人接入指南](https://skillhub.cn/tutorials#alipay-pay)，Pay Skill 需要已注册的支付宝收费服务、公网 HTTPS 业务 API、付款凭证校验和结果交付。SkillHub 展示价、支付宝登记价和服务端账单价必须一致。

本仓库目前是本地提示词创作技能，没有收费后端。正式上架前需要明确收费单位、价格、模型服务和部署位置，再实现并测试支付与业务交付。后端、密钥和订单状态不放入技能 ZIP；现有提示词评测不能作为支付链路已通过的证据。平台提交成功也不等于审核通过或已上架。

## 依据与取舍

- [Agent Skills 规范](https://agentskills.io/specification)：目录结构和可选 metadata。版本在发布层管理是本项目选择，不是规范强制要求。
- [Superpowers 发布记录](https://github.com/obra/superpowers/releases)：参考版本标签与面向使用者的发布说明；不复制大型多客户端仓库的同步配置。
- [Semantic Versioning](https://semver.org/)：兼容性和版本递增原则，以及已发布版本内容不再修改的要求。
- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)：独立维护变更记录，保留 Unreleased 与按日期排列的版本条目。

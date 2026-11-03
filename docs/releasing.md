# 版本与发布

本仓库目前只有一个 skill，使用一个版本序列。`VERSION` 是版本号的唯一来源；Git 标签使用 `vX.Y.Z`，上传到支付宝 SkillPay 的 ZIP 使用同一版本号命名。

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

## 支付宝 SkillPay 发布

将本次构建的 `dist/grill-my-research-X.Y.Z.zip` 上传到已有的 Grill My Research 商品，沿用 ¥9.90 买断制。提交审核后，核对商品状态与公开购买页。具体步骤见 [SkillPay 发布指南](pay-service.md)。

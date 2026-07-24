# 开发者工具箱 Electron 版

这是 `dev_toolbox` 的 Electron + Vue 3 + TypeScript 重写项目。当前已完成第一期骨架和 11 个文本工具。

## 本地运行

需要 Node.js 24 或更高版本以及 pnpm。

```powershell
pnpm install
pnpm dev
```

## 检查与构建

```powershell
pnpm test
pnpm typecheck
pnpm build
```

开发环境、调试与发布流程见 [my_doc/开发、调试与发布指南.md](开发、调试与发布指南.md)。

## 已完成工具

- 文本对比
- SQL IN
- SQL 格式化
- JSON
- Excel 表格提取
- 时间转换
- Base64
- MD5
- URL 编解码
- Cron 表达式
- XML / JSON 互转

后续阶段和验收口径见 [my_doc/Electron重写技术方案.md](my_doc/Electron重写技术方案.md)。

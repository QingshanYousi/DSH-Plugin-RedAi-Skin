# Redai 皮肤（dsh-plugin-redai-skin）

状态：**W3 完成**（分区通透度 + 毛玻璃）

## P0 产物

| 文件 | 内容 |
|---|---|
| `assets/tokens.json` | 官方主题 token 基线：light/dark 各 112 个（alias + specific）、基础层 218 个、调色板 77 个、官方推荐 14 条 |
| `docs/SKIN-TOKENS.md`（仓库根） | 同上的人类可读版：分组表 + 双色对照 |

## 数据来源

从 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 静态提取：

- `body{...}` → light 变量表
- `body[data-ds-dark-theme]{...}` → dark 变量表
- `:root` 区 → 基础层（圆角/阴影/动效，**不随配色变化**）
- `--dsw-static-*` → 原始调色板（77 色）
- `BUILTIN_INSPECT_TOKENS` → 官方推荐的 14 个可改 token（带说明与类型）

## 下一步

- P1：皮肤引擎（`ctx.theme.register` / CSS 变量覆盖）+ 3 套内置皮肤
- ~~P2~~ 已完成：设置 → 通用 → 「皮肤」行，5 个色卡即时切换
- P3：导入/导出皮肤包
- P4：壁纸模块（`--wallpaper`，B 档，可单独关闭）

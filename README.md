# LaTeX delimiter fixer

Fix math delimiters pasted from ChatGPT (or any MathJax-default renderer) so they
render in Obsidian (and other `$`-only Markdown renderers).

`\( ... \)` → `$ ... $`  ·  `\[ ... \]` → `$$ ... $$`

![Rendered result after the fix](assets/screenshot-1.png)

## Why

ChatGPT and MathJax-default sites accept `\(...\)` / `\[...\]`. Obsidian's MathJax
only registers `$...$` and `$$...$$`, so GPT-generated notes show raw `\(` noise
instead of formulas. This plugin rewrites them in place.

| Input | Output |
| --- | --- |
| `\(g\)` | `$g$` |
| `\($P_s$\)` (nested) | `$P_s$` |
| `\[\Delta x\]` alone on a line | three-line `$$` block |
| multi-line `\[ ... \]` display block | `$$ ... $$` display block |
| `\(2\,\mathrm{m/s}\)` | `$2\,\mathrm{m/s}$` |

Left untouched on purpose: fenced code, inline code, YAML front matter, Chinese
parentheses such as `（具体应该输出什么动作）`, and regex examples such as
`5. \(xy\) : 匹配字符为xy`, `\[\^0-9 \]\+`. `mode: "all"` converts everything.

## Install

1. Open the DSH plugin market, search for **LaTeX delimiter fixer**, install and
   enable it.
2. Or install this repository's folder as a local bundle from the plugin manager.
   No build step and no runtime dependencies are required.

The plugin activates immediately: the tool and the slash command appear in the
running session without a restart.

## Usage

- Tool `fix_latex_delimiters` — parameters `{ path?, mode?: "auto" | "all", dry_run?: boolean }`.
  Without `path`, the session working directory is scanned recursively.
- Command `/fixlatex [path ...] [--dry] [--all]` — runs inside the host process
  and never creates a model message, so it costs **no tokens**. Add `--dry` to
  preview, drop it to write.

Example:

```text
/fixlatex /home/me/Notes --dry
/fixlatex "/home/me/Notes/秋招/LLM驱动的机器人决策范式.md"
/fixlatex ~/Notes
```

Directories are walked recursively; `.git`, `.obsidian`, `.trash`, `node_modules`,
and `.dsh` are skipped. Unreadable directories are skipped instead of aborting.
Every changed file is reported with a couple of sample replacements.

## 中文说明

ChatGPT 粘贴出来的公式用 `\(...\)`、`\[...\]`，Obsidian 只认 `$...$`、`$$...$$`。
这个插件把两者就地改写：

- 斜杠命令 `/fixlatex 路径 [--dry] [--all]`：在宿主进程里跑，不产生模型消息，**不花 token**；
- 工具 `fix_latex_delimiters`：让 agent 调用，适合批量整理；
- 代码块、行内代码、front matter、中文括号、正则示例默认不动。

## Layout

- `index.js` — Cordis plugin: registers the tool and the slash command, no imports.
- `lib/transform.js` — dependency-free Markdown state machine
  (`transformMarkdown`, `runFix`, `summarize`).
- `cordis.patch.yml` — bundle patch that inserts the plugin.
- `locale/` — bundle title and description for the plugin manager.
- `assets/` — screenshots shown here and in the market.

## License

MIT

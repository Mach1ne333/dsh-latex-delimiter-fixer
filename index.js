/**
 * LaTeX delimiter fixer for Markdown notes.
 *
 * ChatGPT and many web renderers accept `\(...\)` and `\[...\]` math
 * delimiters, but Obsidian's MathJax only recognises `$...$` and `$$...$$`,
 * so pasted formulas show up as raw source. This plugin rewrites the
 * delimiters while leaving code fences, inline code, front matter, regex
 * examples, and prose-like `(...)` untouched.
 *
 * Two entry points share one implementation:
 * - tool `fix_latex_delimiters` for agent-driven runs;
 * - slash command `/fixlatex` that executes without a model round trip.
 * @module @local/dsh-latex-delimiter-fixer
 */
import { runFix, summarize } from './lib/transform.js'

/** Cordis plugin name. */
export const name = 'latex-delimiter-fixer'

/** Services this plugin needs. */
export const inject = ['tools', 'commands', 'workingDirectory']

const TOOL_NAME = 'fix_latex_delimiters'
const COMMAND_NAME = 'fixlatex'
const USAGE = 'Usage: /fixlatex [path ...] [--dry] [--all]'

/** Translate a thrown value into a readable message. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Split `/fixlatex` input into paths and options. */
function parseCommandInput(rawInput) {
  const tokens = (rawInput.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => {
      const quoted = token.length > 1 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]
      return quoted ? token.slice(1, -1) : token
    })
    .filter((token) => token.length > 0)
  const paths = []
  let dryRun = false
  let mode = 'auto'
  for (const token of tokens) {
    if (token === '--dry' || token === '--dry-run') {
      dryRun = true
    } else if (token === '--all') {
      mode = 'all'
    } else if (token === '--help' || token === '-h') {
      return { help: true }
    } else if (token.startsWith('-')) {
      return { error: `Unknown option: ${token}` }
    } else {
      paths.push(token)
    }
  }
  return { paths, dryRun, mode }
}

/**
 * Register the LaTeX delimiter tool and slash command for this composition.
 * @param ctx - context providing tools, commands, and the session directory.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposeTool = ctx.tools.register({
      name: TOOL_NAME,
      description: [
        'Rewrite LaTeX math delimiters in Markdown notes from ChatGPT/MathJax syntax to Obsidian syntax.',
        '\\( ... \\) becomes $ ... $ and \\[ ... \\] becomes $$ ... $$.',
        'A single-line \\[ ... \\] becomes a three-line display block; a lone \\[ ... \\] block only swaps its delimiters.',
        'Skips code fences, inline code, front matter, and prose-like regions such as regex examples (5. \\(xy\\) : ...) or Chinese text wrapped in parentheses.',
        'Pass a file or a directory; directories are walked recursively, ignoring .git, .obsidian, node_modules, and .trash.',
        'Writes files in place unless dry_run is true, and reports each changed file with sample replacements.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Markdown file or directory to fix. Defaults to the session working directory.',
          },
          mode: {
            type: 'string',
            enum: ['auto', 'all'],
            description: 'auto (default) skips prose-like and regex-like delimiters; all converts every match.',
          },
          dry_run: {
            type: 'boolean',
            description: 'Preview changes without writing files. Defaults to false.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: {
              type: 'string',
              description: 'Human-readable summary of the run.',
            },
            scanned: {
              type: 'integer',
              description: 'Number of Markdown files scanned.',
            },
            changed_files: {
              type: 'integer',
              description: 'Number of Markdown files with replacements.',
            },
            changed_occurrences: {
              type: 'integer',
              description: 'Number of delimiter replacements.',
            },
            dry_run: {
              type: 'boolean',
              description: 'Whether the run only previewed changes.',
            },
            missing: {
              type: 'array',
              items: { type: 'string' },
              description: 'Targets that do not exist.',
            },
          },
          required: ['summary', 'scanned', 'changed_files', 'changed_occurrences', 'dry_run', 'missing'],
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const baseDir = exec.agent === undefined
          ? process.cwd()
          : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const target = typeof input.path === 'string' && input.path.trim().length > 0
          ? input.path.trim()
          : baseDir
        const mode = input.mode === 'all' ? 'all' : 'auto'
        const dryRun = input.dry_run === true
        const result = await runFix([target], { mode, dryRun, baseDir })
        if (result.missing.length > 0 && result.scanned === 0) {
          throw new Error(`Path not found: ${result.missing.join(', ')}`)
        }
        return {
          summary: summarize(result, dryRun),
          scanned: result.scanned,
          changed_files: result.changedFiles,
          changed_occurrences: result.changedOccurrences,
          dry_run: dryRun,
          missing: result.missing,
        }
      },
    })

    const disposeCommand = ctx.commands.register({
      name: COMMAND_NAME,
      description: 'Fix \\(...\\) and \\[...\\] LaTeX delimiters in Markdown notes for Obsidian',
      input: { hint: '[path ...] [--dry] [--all]' },
      async handler(invocation) {
        const parsed = parseCommandInput(invocation.rawInput)
        if (parsed.help === true) {
          return {
            kind: 'success',
            text: [
              USAGE,
              '',
              'Without a path the session working directory is used; directories are walked recursively.',
              '--dry previews changes, --all also converts prose-like and regex-like delimiters.',
            ].join('\n'),
          }
        }
        if (parsed.error !== undefined) {
          return { kind: 'error', text: `${parsed.error}\n${USAGE}` }
        }
        try {
          const baseDir = await ctx.workingDirectory.ensure(invocation.agent, invocation.signal)
          const targets = parsed.paths.length > 0 ? parsed.paths : [baseDir]
          const result = await runFix(targets, { mode: parsed.mode, dryRun: parsed.dryRun, baseDir })
          if (result.missing.length > 0 && result.scanned === 0) {
            return { kind: 'error', text: `Path not found: ${result.missing.join(', ')}` }
          }
          return { kind: 'success', text: summarize(result, parsed.dryRun, 20) }
        } catch (error) {
          if (invocation.signal.aborted) return { kind: 'error', text: 'LaTeX fixer cancelled.' }
          return { kind: 'error', text: `LaTeX fixer failed: ${errorText(error)}` }
        }
      },
    })

    return () => {
      disposeTool()
      disposeCommand()
    }
  }, 'latex-delimiter-fixer lifecycle')
}

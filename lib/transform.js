/**
 * Markdown LaTeX-delimiter transformer.
 *
 * Obsidian's MathJax registers only `$...$` and `$$...$$`; ChatGPT and other
 * MathJax-based chat UIs emit `\(...\)` / `\[...\]`, which Obsidian then shows
 * as literal text. This module rewrites those delimiters while leaving code,
 * frontmatter, and prose-like parenthesised text alone.
 *
 * Pure functions only: no cordis, no Harness imports, so it can be unit-tested
 * with plain `node`.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Directories never scanned for notes. */
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.dsh'])
/** Opening or closing line of a fenced code block. */
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/

/**
 * Whether the body of an inline `\(...\)` looks like prose rather than math.
 * Bare multi-letter words (`\(xy\)`, `\(the\)`) are almost always escaped
 * parentheses in prose or code documentation, not formulas, so `mode: 'auto'`
 * leaves them untouched. Anything with LaTeX syntax, digits, operators, or a
 * single symbol is treated as math.
 * @param {string} body - raw text between the delimiters.
 * @returns {boolean} true when the region should be skipped in auto mode.
 */
/**
 * Whether the body of a delimiter region looks like an escaped regex
 * character class rather than a formula. Notes that document regular
 * expressions write `\[\^0-9 \]`, `\(abc\+\)`, and similar, which are not
 * math; LaTeX almost never uses `\^`, `\+`, `\?`, `\*`, or `\|`, and uses
 * `\d`, `\w`, `\s` only as the start of longer commands such as `\delta`.
 * @param {string} body - raw text between the delimiters.
 * @returns {boolean} true when the region should be skipped in auto mode.
 */
export function looksLikeRegex(body) {
  if (/\\[\^+?*|]/.test(body)) return true
  if (/\\[dDwWsS](?![A-Za-z])/.test(body)) return true
  return false
}

export function looksLikeProse(body) {
  const text = body.trim()
  if (text === '') return true
  if (/[\\^_$]/.test(text)) return false
  if (/[0-9=+\-*/<>()[\]{}|,;:!?]/.test(text)) return false
  if (/[\u3400-\u9fff]/.test(text)) return true
  if (/^[A-Za-z]{2,}$/.test(text)) return true
  return false
}

/**
 * Normalise the body of an inline math region.
 * `\($P_s$\)` (a `$...$` pair wrapped in `\(...\)`) collapses to `P_s` so the
 * caller can wrap it exactly once.
 * @param {string} body - raw text between `\(` and `\)`.
 * @returns {string} body without surrounding whitespace or stray `$`.
 */
export function normalizeInlineBody(body) {
  return body.trim().replace(/\$/g, '')
}

/**
 * Split one line into alternating plain-text and inline-code segments, so
 * delimiters inside backtick spans are never rewritten.
 * @param {string} line - one physical line, without its newline.
 * @returns {Array<{text: string, code: boolean}>} ordered segments.
 */
export function splitCodeSpans(line) {
  /** @type {Array<{text: string, code: boolean}>} */
  const parts = []
  const re = /(`+)([^`]*?)\1/g
  let last = 0
  let match
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) parts.push({ text: line.slice(last, match.index), code: false })
    parts.push({ text: match[0], code: true })
    last = match.index + match[0].length
  }
  if (last < line.length) parts.push({ text: line.slice(last), code: false })
  return parts
}

/**
 * Rewrite inline math delimiters inside one plain-text segment.
 * @param {string} segment - text outside inline code.
 * @param {'auto'|'all'} mode - `auto` skips prose-like inline regions.
 * @param {(line: number, before: string, after: string) => void} record - change sink.
 * @param {number} lineNo - zero-based line index for reporting.
 * @returns {string} converted segment.
 */
function convertSegment(segment, mode, record, lineNo) {
  let out = segment.replace(/(?<!\\)\\\[([^\n]*?)(?<!\\)\\\]/g, (matched, body) => {
    const inner = body.trim()
    if (inner === '') return matched
    if (mode !== 'all' && (looksLikeProse(inner) || looksLikeRegex(inner))) return matched
    const replacement = `$$${inner}$$`
    if (replacement !== matched) record(lineNo, matched, replacement)
    return replacement
  })
  out = out.replace(/(?<!\\)\\\(([^\n]*?)(?<!\\)\\\)/g, (matched, body) => {
    if (mode !== 'all' && (looksLikeProse(body) || looksLikeRegex(body))) return matched
    const inner = normalizeInlineBody(body)
    if (inner === '') return matched
    const replacement = `$${inner}$`
    if (replacement !== matched) record(lineNo, matched, replacement)
    return replacement
  })
  return out
}

/**
 * Convert the delimiters of every Markdown line outside fenced code,
 * frontmatter, and inline code.
 * @param {string} source - complete file contents.
 * @param {{mode?: 'auto'|'all'}} [options] - conversion mode.
 * @returns {{text: string, changes: Array<{line: number, before: string, after: string}>}} converted text and per-change records.
 */
export function transformMarkdown(source, options = {}) {
  const mode = options.mode === 'all' ? 'all' : 'auto'
  /** @type {Array<{line: number, before: string, after: string}>} */
  const changes = []
  const record = (lineNo, before, after) => {
    changes.push({ line: lineNo + 1, before, after })
  }
  const lines = source.split('\n')
  const out = []
  /** @type {{char: string, len: number}|null} */
  let fence = null
  let inFrontmatter = false
  let inDisplay = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (i === 0 && trimmed === '---') {
      inFrontmatter = true
      out.push(line)
      continue
    }
    if (inFrontmatter) {
      out.push(line)
      if (trimmed === '---' || trimmed === '...') inFrontmatter = false
      continue
    }

    const fenceOpen = FENCE_RE.exec(line)
    if (fence !== null) {
      out.push(line)
      if (fenceOpen !== null && fenceOpen[2][0] === fence.char && fenceOpen[2].length >= fence.len && fenceOpen[3].trim() === '') {
        fence = null
      }
      continue
    }
    if (fenceOpen !== null) {
      fence = { char: fenceOpen[2][0], len: fenceOpen[2].length }
      out.push(line)
      continue
    }

    if (inDisplay) {
      if (trimmed === '\\]') {
        out.push(line.replace(/\\\]/, () => '$$'))
        record(i, '\\]', '$$')
        inDisplay = false
      } else {
        out.push(line)
      }
      continue
    }
    if (trimmed === '\\[') {
      out.push(line.replace(/\\\[/, () => '$$'))
      record(i, '\\[', '$$')
      inDisplay = true
      continue
    }

    // A single-line `\[ ... \]` that is alone on its line becomes a proper
    // display block rather than an inline one.
    const wholeLineDisplay = /^([ \t]*)\\\[([\s\S]*?)\\\]([ \t]*)$/.exec(line)
    if (wholeLineDisplay !== null) {
      const inner = wholeLineDisplay[2].trim()
      if (inner !== '') {
        const indent = wholeLineDisplay[1]
        const replacement = `${indent}$$\n${indent}${inner}\n${indent}$$${wholeLineDisplay[3]}`
        record(i, line.trim(), replacement.trim())
        out.push(replacement)
        continue
      }
    }

    const segments = splitCodeSpans(line)
    if (segments.length === 1 && !segments[0].code) {
      out.push(convertSegment(line, mode, record, i))
    } else {
      out.push(segments.map((part) => (part.code ? part.text : convertSegment(part.text, mode, record, i))).join(''))
    }
  }

  return { text: out.join('\n'), changes }
}

/**
 * Expand a leading `~` and resolve a path against a base directory.
 * @param {string} target - user-supplied path.
 * @param {string} baseDir - directory for relative paths.
 * @returns {string} absolute path.
 */
export function resolveTarget(target, baseDir) {
  const home = process.env.HOME ?? baseDir
  if (target === '~') return home
  if (target.startsWith('~/')) return path.join(home, target.slice(2))
  return path.resolve(baseDir, target)
}

/**
 * Collect Markdown files under one directory, skipping tooling directories.
 * @param {string} dir - absolute directory.
 * @param {string[]} acc - accumulator of absolute file paths.
 * @returns {Promise<void>}
 */
async function walkMarkdown(dir, acc) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    // Unreadable directories (permissions, races, virtual filesystems) are
    // skipped so one protected folder cannot abort a whole vault run.
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkMarkdown(full, acc)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      acc.push(full)
    }
  }
}

/** Shorten a snippet for human-facing output. */
function snippet(text) {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat
}

/**
 * Fix every Markdown file under the given targets.
 * @param {string[]} targets - files or directories, absolute or relative to `baseDir`.
 * @param {{mode?: 'auto'|'all', dryRun?: boolean, baseDir?: string}} [options] - run options.
 * @returns {Promise<{scanned: number, changedFiles: number, changedOccurrences: number, missing: string[], files: Array<{path: string, occurrences: number, samples: string[]}>}>} run summary.
 */
export async function runFix(targets, options = {}) {
  const mode = options.mode === 'all' ? 'all' : 'auto'
  const dryRun = options.dryRun === true
  const baseDir = options.baseDir ?? process.cwd()
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const missing = []

  for (const target of targets) {
    const resolved = resolveTarget(target, baseDir)
    let stat
    try {
      stat = await fs.stat(resolved)
    } catch {
      missing.push(resolved)
      continue
    }
    if (stat.isDirectory()) {
      await walkMarkdown(resolved, files)
    } else if (stat.isFile() && resolved.toLowerCase().endsWith('.md')) {
      files.push(resolved)
    }
  }

  const unique = [...new Set(files)]
  const changed = []
  for (const file of unique) {
    const source = await fs.readFile(file, 'utf8')
    const { text, changes } = transformMarkdown(source, { mode })
    if (changes.length === 0) continue
    if (!dryRun) await fs.writeFile(file, text, 'utf8')
    changed.push({
      path: file,
      occurrences: changes.length,
      samples: changes.slice(0, 2).map((change) => `L${change.line}: ${snippet(change.before)} -> ${snippet(change.after)}`),
    })
  }

  return {
    scanned: unique.length,
    changedFiles: changed.length,
    changedOccurrences: changed.reduce((sum, file) => sum + file.occurrences, 0),
    missing,
    files: changed,
  }
}

/**
 * Render a run summary as short plain text for tool results and command output.
 * @param {{scanned: number, changedFiles: number, changedOccurrences: number, missing: string[], files: Array<{path: string, occurrences: number, samples: string[]}>}} summary - `runFix` result.
 * @param {boolean} dryRun - whether the run only previewed changes.
 * @param {number} [maxFiles] - maximum per-file lines to print.
 * @returns {string} human-facing summary.
 */
export function summarize(summary, dryRun, maxFiles = 12) {
  const verb = dryRun ? 'Would fix' : 'Fixed'
  const lines = []
  if (summary.changedFiles === 0) {
    lines.push(`No LaTeX delimiter changes needed (${summary.scanned} Markdown file${summary.scanned === 1 ? '' : 's'} scanned).`)
  } else {
    lines.push(`${verb} ${summary.changedFiles} of ${summary.scanned} Markdown file${summary.scanned === 1 ? '' : 's'} (${summary.changedOccurrences} replacement${summary.changedOccurrences === 1 ? '' : 's'}).`)
    for (const file of summary.files.slice(0, maxFiles)) {
      lines.push(`- ${file.path}: ${file.occurrences}${file.samples.length > 0 ? ` (${file.samples.join('; ')})` : ''}`)
    }
    if (summary.files.length > maxFiles) lines.push(`- ... and ${summary.files.length - maxFiles} more file(s)`)
    if (dryRun) lines.push('Preview only: re-run without --dry to apply.')
  }
  if (summary.missing.length > 0) {
    lines.push(`Not found: ${summary.missing.join(', ')}`)
  }
  return lines.join('\n')
}

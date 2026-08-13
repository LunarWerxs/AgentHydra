import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
// The secret patterns moved to ./secrets so the transcript export and the session scan share them
// with this file rather than keeping a second copy that drifts.
import { containsHighConfidenceSecret } from './secrets'
import type { ChatGptContextPack } from './types'

const MAX_CANDIDATES = 5000
const MAX_FILE_BYTES = 256 * 1024
const MAX_PACK_CHARS = 400_000
const SKIP_DIRECTORIES = new Set([
  '.aws',
  '.azure',
  '.git',
  '.gnupg',
  '.kube',
  '.next',
  '.nuxt',
  '.ssh',
  '.venv',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'tmp',
  'vendor',
  'venv',
])

interface Candidate {
  absolutePath: string
  relativePath: string
  score: number
}

interface CandidateList {
  candidates: Candidate[]
  hitCandidateLimit: boolean
}

function safeRelativePath(root: string, absolutePath: string): string | null {
  const rel = relative(root, absolutePath)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.replaceAll('\\', '/')
}

function isSensitiveFilename(relativePath: string): boolean {
  const leaf = basename(relativePath).toLowerCase()
  if (leaf === '.env.example' || leaf === '.env.sample' || leaf === '.env.template') return false
  return (
    leaf === '.env' ||
    leaf.startsWith('.env.') ||
    leaf === '.npmrc' ||
    leaf === '.pypirc' ||
    leaf === 'auth.json' ||
    leaf === 'id_rsa' ||
    leaf === 'id_ed25519' ||
    /\.(?:key|p12|pfx|pem)$/i.test(leaf) ||
    /^(?:credentials|secrets?)(?:\.|$)/i.test(leaf)
  )
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.includes(0)) return true
  let controls = 0
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls++
  }
  return sample.length > 0 && controls / sample.length > 0.05
}

function scorePath(relativePath: string, taskWords: Set<string>): number {
  const normalized = relativePath.toLowerCase()
  const leaf = basename(normalized)
  let score = 0
  if (
    leaf === 'agents.md' ||
    leaf === 'readme.md' ||
    leaf === 'package.json' ||
    leaf === 'pyproject.toml' ||
    leaf === 'cargo.toml' ||
    leaf === 'go.mod'
  )
    score += 100
  if (/\.(?:md|txt)$/i.test(leaf)) score += 15
  if (/(?:^|\/)(?:src|app|server|web|lib|packages)\//.test(normalized)) score += 20
  if (/(?:test|spec)\./.test(leaf)) score += 5
  for (const word of taskWords) {
    if (word.length >= 4 && normalized.includes(word)) score += 25
  }
  return score
}

function collectCandidates(root: string, task: string): CandidateList {
  const taskWords = new Set(task.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])
  try {
    const git = Bun.spawnSync(
      ['git', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', windowsHide: true },
    )
    if (git.exitCode === 0) {
      const paths = new TextDecoder().decode(git.stdout).split('\0').filter(Boolean)
      const hitCandidateLimit = paths.length > MAX_CANDIDATES
      const candidates = paths.slice(0, MAX_CANDIDATES).flatMap((gitPath) => {
        const absolutePath = resolve(root, gitPath)
        const relativePath = safeRelativePath(root, absolutePath)
        if (!relativePath) return []
        return [{ absolutePath, relativePath, score: scorePath(relativePath, taskWords) }]
      })
      candidates.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      return { candidates, hitCandidateLimit }
    }
  } catch {
    // Not a Git checkout (or Git is unavailable): use the bounded filesystem walk below.
  }

  const candidates: Candidate[] = []
  let hitCandidateLimit = false

  const visit = (directory: string) => {
    if (hitCandidateLimit) return
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (candidates.length >= MAX_CANDIDATES) {
        hitCandidateLimit = true
        return
      }
      const absolutePath = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) visit(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = safeRelativePath(root, absolutePath)
      if (!relativePath) continue
      candidates.push({
        absolutePath,
        relativePath,
        score: scorePath(relativePath, taskWords),
      })
    }
  }

  visit(root)
  candidates.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
  return { candidates, hitCandidateLimit }
}

function languageHint(path: string): string {
  return extname(path)
    .slice(1)
    .replace(/[^a-z0-9_+-]/gi, '')
}

function markdownFence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

export function createChatGptContextPack(cwd: string, task: string): ChatGptContextPack {
  const trimmedTask = task.trim()
  if (!trimmedTask) throw new Error('Task is required.')
  if (trimmedTask.length > 20_000) throw new Error('Task is too long (maximum 20,000 characters).')

  const requestedRoot = resolve(cwd.trim())
  let root: string
  try {
    root = realpathSync(requestedRoot)
  } catch {
    throw new Error('Working directory does not exist.')
  }
  if (!statSync(root).isDirectory()) throw new Error('Working directory must be a directory.')

  const { candidates, hitCandidateLimit } = collectCandidates(root, trimmedTask)
  const sections: string[] = []
  const includedFiles: string[] = []
  let omittedSensitive = 0
  let omittedBinaryOrLarge = 0
  let omittedForBudget = 0
  let usedChars = 0

  for (const candidate of candidates) {
    if (isSensitiveFilename(candidate.relativePath)) {
      omittedSensitive++
      continue
    }

    let size: number
    try {
      const info = lstatSync(candidate.absolutePath)
      if (!info.isFile()) continue
      size = info.size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) {
      omittedBinaryOrLarge++
      continue
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(candidate.absolutePath)
    } catch {
      continue
    }
    if (looksBinary(buffer)) {
      omittedBinaryOrLarge++
      continue
    }
    const text = buffer.toString('utf8')
    if (containsHighConfidenceSecret(text)) {
      omittedSensitive++
      continue
    }

    const fence = markdownFence(text)
    const section = [
      `## ${candidate.relativePath}`,
      `${fence}${languageHint(candidate.relativePath)}`,
      text,
      fence,
      '',
    ].join('\n')
    if (usedChars + section.length > MAX_PACK_CHARS) {
      omittedForBudget++
      continue
    }
    sections.push(section)
    includedFiles.push(candidate.relativePath)
    usedChars += section.length
  }

  const warnings: string[] = []
  if (omittedSensitive)
    warnings.push(`${omittedSensitive} potentially sensitive file(s) were omitted.`)
  if (omittedBinaryOrLarge)
    warnings.push(`${omittedBinaryOrLarge} binary or oversized file(s) were omitted.`)
  if (omittedForBudget)
    warnings.push(`${omittedForBudget} file(s) were omitted to keep the context pack bounded.`)
  if (hitCandidateLimit)
    warnings.push(`Only the first ${MAX_CANDIDATES} repository files were considered.`)

  const repositoryName = basename(root) || 'repository'
  const content = [
    '# Repository context for ChatGPT',
    '',
    `Repository: ${repositoryName}`,
    '',
    '## Task',
    '',
    trimmedTask,
    '',
    '## Instructions',
    '',
    '- Use this repository context to answer the task above.',
    '- Call out assumptions and missing context.',
    '- Prefer implementation-ready guidance, unified diffs, or complete replacement snippets.',
    '- Do not claim that code was executed or tests passed.',
    '',
    `## Included files (${includedFiles.length})`,
    '',
    includedFiles.map((path) => `- ${path}`).join('\n') || '_No readable source files found._',
    '',
    ...sections,
  ].join('\n')
  const safeRepositoryName =
    repositoryName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'repository'
  const filename = `${safeRepositoryName}-chatgpt-context.md`
  const prompt = [
    `I attached ${filename}, which contains scoped context from ${repositoryName}.`,
    '',
    `Task: ${trimmedTask}`,
    '',
    'Use the attachment as the source of truth. Give me an implementation-ready answer and clearly identify anything that still needs to be verified locally.',
  ].join('\n')

  return {
    filename,
    content,
    prompt,
    includedFiles,
    omittedFiles: omittedSensitive + omittedBinaryOrLarge + omittedForBudget,
    estimatedTokens: Math.ceil(content.length / 4),
    truncated: omittedForBudget > 0 || hitCandidateLimit,
    warnings,
  }
}

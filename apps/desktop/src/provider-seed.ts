/** Seeds preset provider routes into a profile's user patch layer. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { loadOptionalPatches, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'

/** Patch entry id whose `config.providers` holds the route table. */
const SEED_ENTRY_ID = 'llm-pi-ai'

interface SeedModel {
  readonly id: string
  readonly input: readonly string[]
  readonly compat?: Readonly<Record<string, string>>
}

interface SeedProfile {
  readonly displayName: string
  readonly api: string
  readonly baseURL: string
  readonly apiKeyEnv?: string
  readonly compat?: Readonly<Record<string, string | boolean>>
  readonly models: readonly SeedModel[]
}

interface SeedRoute {
  readonly route: string
  readonly profile: SeedProfile
}

/**
 * Preset vendor routes seeded on first materialization and appended on later
 * releases. `ollama` omits `apiKeyEnv`: llm-pi-ai raises MISSING_CREDENTIAL for
 * a named ref that settings never stored, so the local server relies on the
 * credential discovery of pi-ai instead.
 */
const PROVIDER_ROUTE_SEED: readonly SeedRoute[] = [
  { route: 'deepseek', profile: {
    displayName: 'DeepSeek', api: 'openai-completions', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-chat', input: ['text'] },
      { id: 'deepseek-reasoner', input: ['text'], compat: { thinkingFormat: 'deepseek' } },
    ],
  } },
  { route: 'dashscope', profile: {
    displayName: '阿里百炼', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY',
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    models: [{ id: 'qwen-max', input: ['text', 'image'] }],
  } },
  { route: 'zhipu', profile: {
    displayName: '智谱', api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY',
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    models: [{ id: 'glm-4-plus', input: ['text', 'image'] }],
  } },
  { route: 'moonshot', profile: {
    displayName: 'Moonshot', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY',
    models: [{ id: 'moonshot-v1-128k', input: ['text'] }],
  } },
  { route: 'siliconflow', profile: {
    displayName: 'SiliconFlow', api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY',
    models: [{ id: 'deepseek-ai/DeepSeek-V3', input: ['text'] }],
  } },
  { route: 'openrouter', profile: {
    displayName: 'OpenRouter', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [{ id: 'anthropic/claude-sonnet-4.5', input: ['text', 'image'] }],
  } },
  { route: 'ollama', profile: {
    displayName: 'Ollama 本地', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1',
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    models: [{ id: 'qwen2.5:14b', input: ['text'] }],
  } },
]

const DUMP_OPTIONS: yaml.DumpOptions = { noRefs: true, lineWidth: -1, skipInvalid: true }
const SEED_MARKER = '# Seeded provider presets; safe to edit. Release updates append only missing routes.'
const ENTRY_LINE_PATTERN = new RegExp(`^-\\s+id:\\s*${SEED_ENTRY_ID}\\s*$`)
const TOP_LEVEL_ITEM = /^-(\s|$)/

/**
 * Append preset provider routes that the profile patch layer is missing.
 * Configured routes and all other user content stay untouched. Files the
 * seeding cannot edit safely (absent, unparsable, or flow-style target
 * mappings) are skipped; a corrupt layer fails loud at Host boot instead.
 * @param profileDir - profile directory holding {@link PROFILE_PATCH_FILENAME}.
 */
export function seedProviderRoutes(profileDir: string): void {
  const file = join(profileDir, PROFILE_PATCH_FILENAME)
  let patches: ReturnType<typeof loadOptionalPatches>
  try {
    patches = loadOptionalPatches('dsh', file)
  } catch (_unparsable) {
    // Rewriting a corrupt layer would hide the damage from the boot-time failure that reports it.
    return
  }
  if (patches === undefined) return
  const configured = configuredRoutes(patches)
  const missing = PROVIDER_ROUTE_SEED.filter(({ route }) => !configured.has(route))
  if (missing.length === 0) return
  const lines = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').split('\n')
  const seeded = insertRoutes(lines, patches.length === 0, missing)
  if (seeded === undefined) return
  writeFileSync(file, `${seeded.join('\n').trimEnd()}\n`)
}

function configuredRoutes(patches: readonly unknown[]): Set<string> {
  const routes = new Set<string>()
  for (const patch of patches) {
    const entry = patch as { readonly id?: unknown; readonly config?: { readonly providers?: unknown } }
    if (entry?.id !== SEED_ENTRY_ID) continue
    const providers = entry.config?.providers
    if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) continue
    for (const route of Object.keys(providers)) routes.add(route)
  }
  return routes
}

function insertRoutes(lines: string[], emptyLayer: boolean, missing: readonly SeedRoute[]): string[] | undefined {
  if (emptyLayer) {
    const index = lines.findIndex(line => line.trim() === '[]')
    if (index < 0) return undefined
    return [...lines.slice(0, index), ...renderEntry(missing), ...lines.slice(index + 1)]
  }
  const start = lines.findIndex(line => ENTRY_LINE_PATTERN.test(line))
  if (start < 0) {
    // A block-style top-level list accepts a new entry at the end; flow style stays untouched.
    const firstContent = lines.findIndex(line => line.trim() !== '' && !line.trim().startsWith('#'))
    const firstLine = firstContent < 0 ? undefined : lines[firstContent]
    if (firstLine === undefined || !firstLine.startsWith('-')) return undefined
    return [...lines, ...renderEntry(missing)]
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (TOP_LEVEL_ITEM.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  const providers = findMappingKey(lines, start, end, 'providers')
  if (providers !== undefined) {
    if (providers.flow) return undefined
    const stop = blockEnd(lines, providers.index, end, providers.indent)
    return [...lines.slice(0, stop), ...renderRoutes(missing, providers.indent + 2), ...lines.slice(stop)]
  }
  const config = findMappingKey(lines, start, end, 'config')
  if (config !== undefined) {
    if (config.flow) return undefined
    const stop = blockEnd(lines, config.index, end, config.indent)
    return [
      ...lines.slice(0, stop),
      `${' '.repeat(config.indent + 2)}providers:`,
      ...renderRoutes(missing, config.indent + 4),
      ...lines.slice(stop),
    ]
  }
  return [...lines.slice(0, end), '  config:', '    providers:', ...renderRoutes(missing, 6), ...lines.slice(end)]
}

interface MappingKey {
  readonly index: number
  readonly indent: number
  /** True when the key line carries inline (flow or scalar) content. */
  readonly flow: boolean
}

function findMappingKey(lines: string[], start: number, end: number, key: string): MappingKey | undefined {
  const pattern = new RegExp(`^(\\s+)${key}:\\s*(.*)$`)
  for (let i = start; i < end; i += 1) {
    const match = pattern.exec(lines[i] ?? '')
    if (match !== null) {
      return { index: i, indent: (match[1] ?? '').length, flow: (match[2] ?? '').trim() !== '' }
    }
  }
  return undefined
}

function blockEnd(lines: string[], keyIndex: number, limit: number, keyIndent: number): number {
  for (let i = keyIndex + 1; i < limit; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (line.length - trimmed.length <= keyIndent) return i
  }
  return limit
}

function renderEntry(routes: readonly SeedRoute[]): string[] {
  const body = yaml.dump([{ id: SEED_ENTRY_ID, config: { providers: providersObject(routes) } }], DUMP_OPTIONS).trimEnd()
  return [SEED_MARKER, ...body.split('\n')]
}

function renderRoutes(routes: readonly SeedRoute[], indent: number): string[] {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (const { route, profile } of routes) {
    for (const line of yaml.dump({ [route]: profile }, DUMP_OPTIONS).trimEnd().split('\n')) lines.push(pad + line)
  }
  return lines
}

function providersObject(routes: readonly SeedRoute[]): Record<string, SeedProfile> {
  return Object.fromEntries(routes.map(({ route, profile }) => [route, profile] as const))
}

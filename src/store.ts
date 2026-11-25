import { readFile, writeFile } from 'node:fs/promises'

import { readExportDir } from './ingest.ts'
import { scoreThread } from './score.ts'
import { buildThreads, dedupeThreads, DEFAULT_ENTITIES, DEFAULT_TOPIC_RULES } from './thread.ts'
import type { IntelThread } from './types.ts'

export interface ThreadIndex {
  inputMessages: number
  threadCount: number
  dedupedCount: number
  keptCount: number
  items: IntelThread[]
}

export interface IndexOptions {
  entities?: string[]
  topicRules?: Array<[string, RegExp]>
  minScore?: number
}

export async function buildIndex(inputDir: string, options: IndexOptions = {}): Promise<ThreadIndex> {
  const messages = await readExportDir(inputDir)
  const scored = buildThreads(messages, {
    entities: options.entities ?? DEFAULT_ENTITIES,
    topicRules: options.topicRules ?? DEFAULT_TOPIC_RULES,
  }).map(thread => ({ thread, score: scoreThread(thread).score }))
  const deduped = dedupeThreads(scored)
  const minScore = options.minScore ?? 0.35
  const items = deduped
    .map(({ thread }) => thread)
    .filter(thread => scoreThread(thread).score >= minScore)
    .sort((left, right) => scoreThread(right).score - scoreThread(left).score)
  return {
    inputMessages: messages.length,
    threadCount: scored.length,
    dedupedCount: scored.length - deduped.length,
    keptCount: items.length,
    items,
  }
}

export async function saveIndex(index: ThreadIndex, outPath: string): Promise<void> {
  await writeFile(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

export async function loadIndex(path: string): Promise<ThreadIndex> {
  return JSON.parse(await readFile(path, 'utf8')) as ThreadIndex
}

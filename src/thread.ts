import { createHash } from 'node:crypto'

import type { IntelMessage, IntelThread } from './types.ts'

const TRACKING_PARAM = /^(?:utm_.+|fbclid|gclid|ref|ref_src|spm|share|from|source|si)$/i

export const DEFAULT_ENTITIES: string[] = []

export const DEFAULT_TOPIC_RULES: Array<[string, RegExp]> = [
  ['云服务/运维', /cloud|docker|k8s|kubernetes|服务器|带宽|流量|部署|容器|集群/i],
  ['开发/工程', /typescript|python|rust|go|database|postgres|sqlite|sql|bug|报错|编译/i],
  ['AI/工具', /llm|agent|mcp|chatgpt|claude|gemini|api|模型|提示词|开源/i],
  ['教程/文档', /教程|指南|文档|实战|复盘|总结|笔记|wiki/i],
  ['故障/排查', /失败|报错|超时|崩溃|异常|限制|限流|排查|修复/i],
  ['发布/动态', /发布|更新|版本|上线|迁移|公告|评测|对比/i],
  ['活动/优惠', /优惠|折扣|优惠码|coupon|免费|试用|名额/i],
]

const TIME_WORDS = /今天|明天|昨天|本周|周末|截止|限时|最后|名额|库存|补货|开门|关门|有效|到期/i
const NOISE_TEXT = /^(?:\+1|已私|私聊|多少钱|求带|同上|mark|dd|哈{2,}|h{3,}|6{2,}|233+|1{2,}|1|在吗|有人吗|早上好|晚上好|晚安|签到|打卡|路过|顶|看看|支持|收到|谢谢|好的)$/i

const DEFAULT_GAP_SECONDS = 30 * 60
const DEFAULT_MAX_DURATION_SECONDS = 20 * 60
const MAX_THREAD_MESSAGES = 35
const SIMILARITY_THRESHOLD = 0.8
const INVITE_PATTERN = /邀请码\s*[:：]\s*\S+/i
const AD_PATTERN = /注册链接|注册送|返利|推广|代理招募|开户链接/i
const IGNORED_AD_HOSTS = new Set(['t.me', 'telegram.me'])

export interface ThreadOptions {
  entities?: string[]
  topicRules?: Array<[string, RegExp]>
  maxGapSeconds?: number
  maxDurationSeconds?: number
  maxMessages?: number
}

export function normalizeUrl(raw: string): string | null {
  let value = raw.trim()
  if (!value)
    return null
  if (!/^https?:\/\//i.test(value))
    value = `https://${value}`
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))
      url.port = ''
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
    url.search = ''
    for (const [key, paramValue] of params)
      url.searchParams.append(key, paramValue)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host}${path}${url.search}`
  }
  catch {
    return null
  }
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? []
  return matches
    .map(url => url.replace(/[),.;!?，。；、）】》]+$/u, ''))
    .filter(Boolean)
}

export function tokenize(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
  const tokens: string[] = []
  for (const part of cleaned.split(/\s+/)) {
    if (!part)
      continue
    if (/^[a-z0-9]+$/.test(part)) {
      tokens.push(part)
      continue
    }
    const chars = [...part]
    if (chars.length === 1)
      tokens.push(part)
    else
      for (let index = 0; index < chars.length - 1; index++)
        tokens.push(chars[index] + chars[index + 1])
  }
  return tokens
}

function uniqueEntities(text: string, entities: string[]): string[] {
  const lower = text.toLowerCase()
  return entities.filter(entity => lower.includes(entity.toLowerCase()))
}

export function detectTopics(text: string, rules = DEFAULT_TOPIC_RULES): string[] {
  const topics = rules
    .filter(([, pattern]) => pattern.test(text))
    .map(([topic]) => topic)
  return topics.length ? topics : ['其他']
}

function isNoise(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || NOISE_TEXT.test(trimmed))
    return true
  const meaningful = trimmed.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{P}\p{S}\s]/gu, '')
  return !meaningful
}

export function buildThreads(messages: IntelMessage[], options: ThreadOptions = {}): IntelThread[] {
  if (!messages.length)
    return []

  const cleaned = messages.filter(message => !isNoise(message.text))
  if (!cleaned.length)
    return []

  const entities = options.entities ?? DEFAULT_ENTITIES
  const topicRules = options.topicRules ?? DEFAULT_TOPIC_RULES
  const maxGap = options.maxGapSeconds ?? DEFAULT_GAP_SECONDS
  const maxDuration = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS
  const maxMessages = options.maxMessages ?? MAX_THREAD_MESSAGES
  const byChat = new Map<string, IntelMessage[]>()
  for (const message of cleaned) {
    const chatMessages = byChat.get(message.chatId) ?? []
    chatMessages.push(message)
    byChat.set(message.chatId, chatMessages)
  }

  const threads: IntelThread[] = []
  for (const chatMessages of byChat.values()) {
    const sorted = [...chatMessages].sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    let segment: IntelMessage[] = []
    let previous: IntelMessage | undefined

    const flush = () => {
      if (segment.length) {
        threads.push(createThread(segment, entities, topicRules))
        segment = []
      }
    }

    for (const message of sorted) {
      if (segment.length >= maxMessages)
        flush()
      if (
        segment.length
        && previous
        && (message.timestamp - previous.timestamp >= maxGap || message.timestamp - segment[0].timestamp >= maxDuration)
      )
        flush()
      segment.push(message)
      previous = message
    }
    flush()
  }
  return threads.sort((left, right) => left.startedAt - right.startedAt)
}

interface ThreadFingerprint {
  tokens: Set<string>
  urls: Set<string>
  entities: Set<string>
}

function fingerprintOf(thread: IntelThread): ThreadFingerprint {
  const tokens = new Set<string>()
  const urls = new Set<string>()
  for (const message of thread.messages) {
    if (!isNoise(message.text))
      for (const token of tokenize(message.text))
        tokens.add(token)
    for (const raw of [
      ...(message.links ?? []).map(link => link.url),
      ...extractUrls(message.text),
    ]) {
      const url = normalizeUrl(raw)
      if (url)
        urls.add(url)
    }
  }
  return { tokens, urls, entities: new Set(thread.entities) }
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size)
    return 0
  let intersection = 0
  for (const value of left) {
    if (right.has(value))
      intersection++
  }
  return intersection / (left.size + right.size - intersection)
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value))
      return true
  }
  return false
}

function isDuplicateThread(left: ThreadFingerprint, right: ThreadFingerprint): boolean {
  if (!left.tokens.size || !right.tokens.size)
    return left.urls.size > 0 && jaccard(left.urls, right.urls) >= 0.999
  const smaller = Math.min(left.tokens.size, right.tokens.size)
  const larger = Math.max(left.tokens.size, right.tokens.size)
  if (smaller / larger < SIMILARITY_THRESHOLD)
    return false
  const similarity = jaccard(left.tokens, right.tokens)
  if (similarity < SIMILARITY_THRESHOLD)
    return false
  if (similarity >= 0.999)
    return true
  return intersects(left.urls, right.urls) || intersects(left.entities, right.entities)
}

function adKeyOf(thread: IntelThread): string | null {
  const text = thread.messages.map(message => message.text).join('\n')
  const invite = INVITE_PATTERN.test(text)
  const hosts = new Set<string>()
  for (const message of thread.messages) {
    for (const raw of [
      ...(message.links ?? []).map(link => link.url),
      ...extractUrls(message.text),
    ]) {
      const url = normalizeUrl(raw)
      if (!url)
        continue
      try {
        const host = new URL(url).hostname.toLowerCase()
        if (!IGNORED_AD_HOSTS.has(host))
          hosts.add(host)
      }
      catch {
        continue
      }
    }
  }
  const sortedHosts = [...hosts].sort()
  if (!invite && !(AD_PATTERN.test(text) && sortedHosts.length))
    return null
  const entities = [...thread.entities].sort()
  if (invite) {
    if (sortedHosts.length) {
      const primaryHost = [...sortedHosts].sort((left, right) =>
        left.split('.').length - right.split('.').length || left.localeCompare(right))[0]
      return `${thread.chatId}|invite|${primaryHost}`
    }
    const lower = text.toLowerCase()
    const primaryEntity = entities
      .map(entity => ({
        entity,
        hits: lower.split(entity.toLowerCase()).length - 1,
      }))
      .sort((left, right) => right.hits - left.hits || left.entity.localeCompare(right.entity))[0]
    return primaryEntity ? `${thread.chatId}|invite|${primaryEntity.entity}` : null
  }
  if (!entities.length && !sortedHosts.length)
    return null
  return `${thread.chatId}|ad|${entities.join(',')}|${sortedHosts.join(',')}`
}

export function dedupeThreads<T extends { thread: IntelThread; score: number }>(items: T[]): T[] {
  // shortcut: O(n²) dedupe; switch to an inverted index above ~10k threads.
  const sorted = [...items].sort((left, right) =>
    right.score - left.score
    || right.thread.messageCount - left.thread.messageCount
    || left.thread.startedAt - right.thread.startedAt)
  const kept: Array<{ item: T; fingerprint: ThreadFingerprint }> = []
  const adKeys = new Set<string>()
  for (const item of sorted) {
    const adKey = adKeyOf(item.thread)
    if (adKey && adKeys.has(adKey))
      continue
    const fingerprint = fingerprintOf(item.thread)
    if (kept.some(entry => entry.item.thread.chatId === item.thread.chatId && isDuplicateThread(entry.fingerprint, fingerprint)))
      continue
    kept.push({ item, fingerprint })
    if (adKey)
      adKeys.add(adKey)
  }
  return kept.map(entry => entry.item)
}

function createThread(
  messages: IntelMessage[],
  entities: string[],
  topicRules: Array<[string, RegExp]>,
): IntelThread {
  const ordered = [...messages].sort((left, right) => left.timestamp - right.timestamp)
  const chatIds = [...new Set(ordered.map(message => message.chatId))].sort()
  const links = ordered.flatMap(message => [
    ...(message.links ?? []).map(link => link.url),
    ...extractUrls(message.text),
  ].map(normalizeUrl).filter((url): url is string => Boolean(url)))
  const entitySet = new Set(ordered.flatMap(message => uniqueEntities(message.text, entities)))
  const topicSet = new Set(ordered.flatMap(message => detectTopics(message.text, topicRules)))
  if (topicSet.size > 1)
    topicSet.delete('其他')
  const id = createHash('sha1')
    .update(`${chatIds.join(',')}:${ordered[0].id}`)
    .digest('hex')
    .slice(0, 16)
  return {
    id,
    chatId: ordered[0].chatId,
    chatIds,
    startedAt: ordered[0].timestamp,
    endedAt: ordered[ordered.length - 1].timestamp,
    messages: ordered,
    messageCount: ordered.length,
    participantCount: new Set(ordered.map(message => message.senderId)).size,
    linkCount: links.length,
    entities: [...entitySet],
    topics: [...topicSet],
    replyDepth: replyDepthOf(ordered),
  }
}

function replyDepthOf(messages: IntelMessage[]): number {
  const byId = new Map(messages.map(message => [`${message.chatId}:${message.id}`, message]))
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (message: IntelMessage): number => {
    const key = `${message.chatId}:${message.id}`
    const cached = memo.get(key)
    if (cached !== undefined)
      return cached
    if (visiting.has(key))
      return 0
    visiting.add(key)
    const parent = message.replyToId
      ? byId.get(`${message.replyToChatId ?? message.chatId}:${message.replyToId}`)
      : undefined
    const value = parent ? depth(parent) + 1 : 0
    visiting.delete(key)
    memo.set(key, value)
    return value
  }
  return messages.reduce((max, message) => Math.max(max, depth(message)), 0)
}

export function isNoiseMessage(text: string): boolean {
  return isNoise(text)
}

export { TIME_WORDS }

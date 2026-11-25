import type { IntelThread } from './types.ts'

export interface SearchHit {
  threadId: string
  messageId: string
  chatId: string
  timestamp: number
  senderName: string
  text: string
  score: number
}

export interface SearchOptions {
  days?: number
  limit?: number
  now?: number
}

function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}

export function searchMessages(threads: IntelThread[], query: string, options: SearchOptions = {}): SearchHit[] {
  const terms = termsOf(query)
  if (!terms.length)
    return []
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const days = options.days ?? 30
  const from = now - days * 24 * 3600
  const limit = options.limit ?? 20
  const hits: SearchHit[] = []

  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.timestamp < from)
        continue
      const lower = message.text.toLowerCase()
      let hitsCount = 0
      for (const term of terms) {
        if (lower.includes(term))
          hitsCount++
      }
      if (!hitsCount)
        continue
      const coverage = hitsCount / terms.length
      const density = Math.min(1, hitsCount / Math.max(1, lower.length / 80))
      const recency = Math.max(0, 1 - (now - message.timestamp) / (days * 24 * 3600))
      hits.push({
        threadId: thread.id,
        messageId: message.id,
        chatId: message.chatId,
        timestamp: message.timestamp,
        senderName: message.senderName,
        text: message.text,
        score: Number((coverage * 2 + density + recency).toFixed(3)),
      })
    }
  }
  return hits.sort((left, right) => right.score - left.score || right.timestamp - left.timestamp).slice(0, limit)
}

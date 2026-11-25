import type { IntelThread } from './types.ts'

import { isNoiseMessage, TIME_WORDS } from './thread.ts'

export interface ScoreBreakdown {
  hasLink: number
  entityHits: number
  timeWordHits: number
  participants: number
  replies: number
  novelty: number
  crossGroup: number
  infoDensity: number
  duplicateRatio: number
  noiseRatio: number
  meaningfulCount: number
}

export interface ThreadScore {
  score: number
  keep: boolean
  parts: ScoreBreakdown
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function scoreThread(thread: IntelThread): ThreadScore {
  const messages = thread.messages
  const total = messages.length
  const noiseCount = messages.filter(message => isNoiseMessage(message.text)).length
  const meaningful = messages.filter(message => !isNoiseMessage(message.text))
  const uniqueTexts = new Set(meaningful.map(message => normalizeText(message.text)))
  const timeWordCount = meaningful.filter(message => TIME_WORDS.test(message.text)).length
  const replyCount = messages.filter(message => message.replyToId).length
  const averageLength = meaningful.length
    ? meaningful.reduce((sum, message) => sum + message.text.trim().length, 0) / meaningful.length
    : 0

  const parts: ScoreBreakdown = {
    hasLink: thread.linkCount > 0 ? 1 : 0,
    entityHits: clamp(thread.entities.length / 3),
    timeWordHits: clamp(timeWordCount / 3),
    participants: clamp(thread.participantCount / 5),
    replies: clamp(replyCount / 5),
    novelty: meaningful.length ? uniqueTexts.size / meaningful.length : 0,
    crossGroup: thread.chatIds.length > 1 ? 1 : 0,
    infoDensity: clamp(averageLength / 120),
    duplicateRatio: meaningful.length ? 1 - uniqueTexts.size / meaningful.length : 0,
    noiseRatio: total ? noiseCount / total : 0,
    meaningfulCount: meaningful.length,
  }

  const score = 3.0 * parts.hasLink
    + 2.0 * parts.entityHits
    + 2.0 * parts.timeWordHits
    + 1.5 * parts.participants
    + 1.0 * parts.replies
    + 1.5 * parts.novelty
    + 1.0 * parts.crossGroup
    + 0.5 * parts.infoDensity
    - 2.0 * parts.duplicateRatio
    - 2.0 * parts.noiseRatio

  const hasSignal = parts.hasLink > 0 || parts.entityHits > 0 || parts.timeWordHits > 0
  const dropsForThinContent = parts.meaningfulCount < 2 && parts.hasLink === 0 && parts.entityHits === 0
  const keep = !dropsForThinContent && (score >= 0.35 || hasSignal)
  return { score, keep, parts }
}

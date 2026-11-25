import assert from 'node:assert/strict'
import test from 'node:test'

import { searchMessages } from '../src/search.ts'
import { buildThreads } from '../src/thread.ts'
import type { IntelMessage } from '../src/types.ts'

function message(id: string, timestamp: number, text: string): IntelMessage {
  return {
    id,
    chatId: 'g1',
    senderId: 'u1',
    senderName: 'Alice',
    timestamp,
    text,
  }
}

const threads = buildThreads([
  message('1', 1000, 'Docker 部署 PostgreSQL 失败了'),
  message('2', 1010, 'Volume 权限也不行'),
  message('3', 5000, 'Redis 8 发布预览版了'),
])

test('search finds matching messages with thread ids', () => {
  const hits = searchMessages(threads, 'Docker', { days: 30, now: 6000 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].messageId, '1')
  assert.equal(hits[0].threadId, threads[0].id)
})

test('search respects the day window', () => {
  const hits = searchMessages(threads, 'Redis', { days: 0.01, now: 6000 })
  assert.equal(hits.length, 0)
})

test('search respects limit', () => {
  const hits = searchMessages(threads, 'Volume', { days: 30, now: 6000, limit: 0 })
  assert.equal(hits.length, 0)
})

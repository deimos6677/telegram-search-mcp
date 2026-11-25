import assert from 'node:assert/strict'
import test from 'node:test'

import { buildThreads, dedupeThreads, isNoiseMessage } from '../src/thread.ts'
import type { IntelMessage } from '../src/types.ts'

function message(id: string, timestamp: number, text: string, chatId = 'g1'): IntelMessage {
  return {
    id,
    chatId,
    senderId: 'u1',
    senderName: 'Alice',
    timestamp,
    text,
  }
}

test('noise-only messages produce no thread', () => {
  const threads = buildThreads([message('1', 1000, '+1'), message('2', 1010, '哈哈哈')])
  assert.equal(threads.length, 0)
})

test('a 30-minute gap splits threads', () => {
  const threads = buildThreads([
    message('1', 1000, 'Docker 部署 PostgreSQL 失败'),
    message('2', 1060, 'Volume 权限也不行'),
    message('3', 1060 + 31 * 60, '换个话题，Redis 8 发布预览版了'),
  ])
  assert.equal(threads.length, 2)
})

test('a segment never exceeds 35 messages', () => {
  const messages = Array.from({ length: 40 }, (_, index) =>
    message(String(index + 1), 1000 + index * 10, `第 ${index + 1} 条有效消息`))
  const threads = buildThreads(messages)
  assert.equal(threads.length, 2)
  assert.equal(threads[0].messageCount, 35)
  assert.equal(threads[1].messageCount, 5)
})

test('same invite campaign keeps one highest-scored thread', () => {
  const first = buildThreads([
    message('1', 1000, 'DemoApp 邀请码：ABC123 注册送额度'),
    message('2', 1010, '注册链接 https://example.com/invite'),
  ])[0]
  const second = buildThreads([
    message('3', 2000, 'DemoApp 邀请码：ABC123 注册送额度'),
    message('4', 2010, '注册链接 https://example.com/invite'),
    message('5', 2020, '再补一句，额度到账了'),
  ])[0]
  const kept = dedupeThreads([
    { thread: first, score: 2 },
    { thread: second, score: 5 },
  ])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].thread.id, second.id)
})

test('noise detector catches greetings but keeps real content', () => {
  assert.equal(isNoiseMessage('+1'), true)
  assert.equal(isNoiseMessage('早上好'), true)
  assert.equal(isNoiseMessage('Docker 部署 PostgreSQL 失败'), false)
})

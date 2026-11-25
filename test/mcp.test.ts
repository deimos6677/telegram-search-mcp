import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { buildIntelDb, queryIntelDb } from '../src/db.ts'

test('MCP server exposes search and read tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-intel-'))
  const inputDir = join(directory, 'export')
  const dbPath = join(directory, 'intel.db')
  await mkdir(inputDir)
  await cp('test/fixtures/sample.jsonl', join(inputDir, 'sample.jsonl'))
  buildIntelDb({ dbPath, exportDir: inputDir })

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'src/mcp-server.ts'),
    ],
    env: { ...env, TG_INTEL_DB: dbPath, TG_INTEL_WIKI_DIR: '' },
  })
  const client = new Client({ name: 'telegram-intel-test', version: '0.2.0' })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(
      tools.tools.map(tool => tool.name).sort(),
      ['db_stats', 'read_context', 'recent_messages', 'search_messages'],
    )

    const search = await client.callTool({
      name: 'search_messages',
      arguments: { query: 'Docker', days: 3650 },
    })
    const payload = JSON.parse((search.content as Array<{ text: string }>)[0].text)
    assert.equal(payload.hits[0].message_id, '1')

    const read = await client.callTool({
      name: 'read_context',
      arguments: { chat_id: payload.hits[0].chat_id, message_id: payload.hits[0].message_id },
    })
    const ctx = JSON.parse((read.content as Array<{ text: string }>)[0].text)
    assert.equal(ctx.messages.length, 3)
    assert.equal(ctx.target_message_id, '1')

    await writeFile(
      join(inputDir, 'extra.jsonl'),
      '{"id":"99","chatId":"g1","senderId":"u9","senderName":"Dave","timestamp":1790000300,"text":"Kubernetes 容器编排重载测试"}\n',
    )
    buildIntelDb({ dbPath, exportDir: inputDir })

    const reloaded = await client.callTool({
      name: 'search_messages',
      arguments: { query: 'k8s', days: 3650 },
    })
    const reloadedPayload = JSON.parse((reloaded.content as Array<{ text: string }>)[0].text)
    assert.equal(reloadedPayload.hits[0].message_id, '99')
  }
  finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('build-db refuses to wipe the db when the export dir has no messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-intel-guard-'))
  const dbPath = join(directory, 'intel.db')
  try {
    buildIntelDb({ dbPath, exportDir: 'test/fixtures' })
    assert.throws(() => buildIntelDb({ dbPath, exportDir: join(directory, 'missing') }), /no Telegram messages/)
    await mkdir(join(directory, 'empty'))
    assert.throws(() => buildIntelDb({ dbPath, exportDir: join(directory, 'empty') }), /no Telegram messages/)
    assert.equal(queryIntelDb(dbPath, { query: 'Docker' }).hits[0].message_id, '1')
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('build-db applies external config chat names, exclusions, and custom aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-intel-config-'))
  const dbPath = join(directory, 'intel.db')
  const configPath = join(directory, 'config.json')
  try {
    await writeFile(configPath, JSON.stringify({
      chats: { g1: { name: 'Dev Ops Group', username: 'devops_demo' } },
      excludedChats: ['g2'],
      aliasGroups: [['pgdb', 'postgresql']],
    }))
    const stats = buildIntelDb({ dbPath, exportDir: 'test/fixtures', configPath })
    assert.equal(stats.tgMessages, 3)
    assert.equal(stats.chats.g1.name, 'Dev Ops Group')
    assert.equal(stats.chats.g2, undefined)
    const prev = process.env.TG_INTEL_CONFIG
    process.env.TG_INTEL_CONFIG = configPath
    try {
      const res = queryIntelDb(dbPath, { query: 'pgdb' })
      assert.equal(res.hits[0].message_id, '1')
      assert.equal(res.hits[0].chat_name, 'Dev Ops Group')
      assert.equal(res.hits[0].url, 'https://t.me/devops_demo/1')
    }
    finally {
      if (prev === undefined)
        delete process.env.TG_INTEL_CONFIG
      else
        process.env.TG_INTEL_CONFIG = prev
    }
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { buildIntelDb } from '../src/db.ts'

test('MCP server exposes Obsidian wiki tools when configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-intel-local-'))
  const dbPath = join(directory, 'intel.db')
  const wikiDir = join(directory, 'wiki')
  await mkdir(wikiDir)
  buildIntelDb({ dbPath, exportDir: 'test/fixtures' })

  await writeFile(join(wikiDir, '01 容器入门.md'), [
    '---',
    'title: 容器入门指南',
    'aliases:',
    '  - Kubernetes',
    'tags:',
    '  - 云原生',
    '---',
    '',
    '| 路线 | 下一步 |',
    '|---|---|',
    '| 容器打底 | [[02 集群进阶\\|生产集群部署]] |',
  ].join('\n'))
  await writeFile(join(wikiDir, '02 集群进阶.md'), [
    '---',
    'title: 生产集群部署',
    'aliases:',
    '  - Helm Chart',
    'tags:',
    '  - 运维架构',
    '---',
    '',
    '多节点环境建议配置持久化存储与滚动更新。',
  ].join('\n'))

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'src/mcp-server.ts'),
    ],
    env: {
      ...env,
      TG_INTEL_DB: dbPath,
      TG_INTEL_WIKI_DIR: wikiDir,
    },
  })
  const client = new Client({ name: 'telegram-intel-local-test', version: '0.2.0' })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(
      tools.tools.map(tool => tool.name).sort(),
      ['db_stats', 'read_context', 'read_wiki', 'recent_messages', 'search_messages', 'search_wiki'],
    )

    const listRes = await client.callTool({
      name: 'search_wiki',
      arguments: { query: 'k8s' },
    })
    const hits = JSON.parse((listRes.content as Array<{ text: string }>)[0].text)
    assert.equal(hits[0].title, '容器入门指南')

    const noteRes = await client.callTool({
      name: 'read_wiki',
      arguments: { note: 'Helm Chart' },
    })
    const notePayload = JSON.parse((noteRes.content as Array<{ text: string }>)[0].text)
    assert.equal(notePayload.title, '生产集群部署')
    assert.equal(notePayload.backlinks.length, 1)
    assert.equal(notePayload.backlinks[0].title, '容器入门指南')
  }
  finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

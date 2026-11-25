import { existsSync } from 'node:fs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  getIntelDbStats,
  listRecentMessages,
  queryIntelDb,
  readMessageContext,
  readWikiNote,
  searchWiki,
} from './db.ts'

const dbPath = process.env.TG_INTEL_DB ?? 'data/intel.db'
const wikiDir = process.env.TG_INTEL_WIKI_DIR ?? ''

if (!existsSync(dbPath)) {
  console.error(`failed to find SQLite db at ${dbPath}`)
  console.error('set TG_INTEL_DB or run: telegram-search-mcp build-db --db <intel.db> --input <jsonl-dir>')
  process.exit(1)
}

const server = new McpServer({ name: 'telegram-search-mcp', version: '0.2.0' })

server.tool(
  'search_messages',
  'Full-text + BM25 + bilingual alias search across local exported Telegram groups and optional X (Twitter) posts/bookmarks. Searches full history by default.',
  {
    query: z.string().min(1).describe('Keywords or phrase (Chinese/English aliases auto-expanded, e.g. k8s<->Kubernetes, 数据库<->database)'),
    source: z.enum(['all', 'tg', 'x']).optional().describe('Filter by source: all (default), tg, or x'),
    chat: z.string().optional().describe('Filter by chat_id or chat name substring (e.g. Dev Group, @handle)'),
    sender: z.string().optional().describe('Filter by sender nickname or X handle substring'),
    days: z.number().int().min(0).max(3650).optional().describe('Lookback window in days; 0 or omit for full history'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum hits (default 25)'),
  },
  async ({ query, source, chat, sender, days, limit }) => {
    const result = queryIntelDb(dbPath, { query, source, chat, sender, days, limit })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  },
)

server.tool(
  'read_context',
  'Read full conversation context around a message (reply ancestor chain + direct replies + surrounding chronological messages). Always call before citing complex discussions.',
  {
    chat_id: z.string().min(1).describe('chat_id from search_messages or recent_messages'),
    message_id: z.string().min(1).describe('message_id from search_messages or recent_messages'),
    before: z.number().int().min(0).max(40).optional().describe('Preceding messages in chat (default 8)'),
    after: z.number().int().min(0).max(60).optional().describe('Following messages in chat (default 12)'),
  },
  async ({ chat_id, message_id, before, after }) => {
    const ctx = readMessageContext(dbPath, { chat_id, message_id, before, after })
    if (!ctx) {
      return {
        content: [{ type: 'text', text: `message not found: ${chat_id}/${message_id}` }],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }] }
  },
)

server.tool(
  'recent_messages',
  'List recent substantive messages across Telegram groups and/or X posts.',
  {
    source: z.enum(['all', 'tg', 'x']).optional().describe('Filter source: all (default), tg, or x'),
    chat: z.string().optional().describe('Optional chat_id or chat name substring'),
    days: z.number().int().min(1).max(365).optional().describe('Lookback days (default 3)'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum messages (default 30)'),
  },
  async ({ source, chat, days, limit }) => {
    const items = listRecentMessages(dbPath, { source, chat, days, limit })
    return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] }
  },
)

server.tool(
  'db_stats',
  'Database statistics: Telegram & X message counts, date coverage, and per-channel latest sync time.',
  {},
  async () => {
    return { content: [{ type: 'text', text: JSON.stringify(getIntelDbStats(dbPath), null, 2) }] }
  },
)

if (wikiDir && existsSync(wikiDir)) {
  server.tool(
    'search_wiki',
    'Search or list structured notes in a local Obsidian knowledge base (markdown + frontmatter + wikilinks). Omit query to list all notes.',
    {
      query: z.string().optional().describe('Optional topic/keyword; omit to list full Obsidian knowledge tree'),
    },
    async ({ query }) => {
      return { content: [{ type: 'text', text: JSON.stringify(searchWiki(wikiDir, query), null, 2) }] }
    },
  )

  server.tool(
    'read_wiki',
    'Read an Obsidian knowledge base note by title, filename, alias, or relative path, including outgoing [[links]] and backlinks.',
    {
      note: z.string().min(1).describe('Note title, filename, alias, or path'),
    },
    async ({ note }) => {
      const doc = readWikiNote(wikiDir, note)
      if (!doc) {
        return {
          content: [{ type: 'text', text: `wiki note not found: ${note}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] }
    },
  )
}

await server.connect(new StdioServerTransport())
console.error(`telegram-search-mcp ready: db=${dbPath} wiki=${wikiDir || 'none'}`)

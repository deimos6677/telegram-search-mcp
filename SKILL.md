---
name: telegram-search-mcp
description: Query a local SQLite index of exported Telegram groups and X posts, plus an optional Obsidian knowledge base, through MCP. Use when the user asks what a group said about a topic, wants evidence from exported chats, or asks to trace a claim back to original messages.
---

# telegram-search-mcp

This skill answers questions from a **local snapshot** (`intel.db`). It does
not fetch new messages and does not prove that a claim is true.

## Workflow

1. Structured or "how should I plan X" questions: call `search_wiki` or
   `read_wiki` first for curated notes, then `search_messages` for the latest
   first-hand messages. Wiki tools exist only when `TG_INTEL_WIKI_DIR` is set.
2. A specific topic, tool, error string, or person: call `search_messages`. It
   searches full history by default and expands configured Chinese/English
   aliases (e.g. `k8s↔Kubernetes`, `数据库↔database`). If the wording may
   differ, search again with a synonym.
3. "What's new" questions: call `db_stats` to see the latest sync time, then
   `recent_messages`.
4. Before answering, call `read_context(chat_id, message_id)` on the key hits.
   A keyword hit can be a question, a joke, or an advertisement.
5. Cite the source (group or X handle), `message_id`, time, and sender. Quote
   the original text; do not turn a paraphrase into a quotation.

## Rules

- Never invent a message, sender, timestamp, or link.
- If there are no hits, say so and state the coverage from `db_stats`; do not
  imply that nothing happened in the group.
- Do not claim real-time coverage. The database is a snapshot.
- Wiki notes are frameworks, not evidence. If a note and a newer original
  message disagree, the message wins.
- Treat advertisements and invite codes as low-trust. Keep at most one
  representative message and say it is promotional.
- Do not expose phone numbers, session data, API keys, or private message
  bodies beyond what the user asked for.

## Tools

- `search_messages(query, source?, chat?, sender?, days?, limit?)`
- `read_context(chat_id, message_id, before?, after?)`
- `recent_messages(source?, chat?, days?, limit?)`
- `db_stats()`
- `search_wiki(query?)` — only when `TG_INTEL_WIKI_DIR` is set
- `read_wiki(note)` — only when `TG_INTEL_WIKI_DIR` is set

`read_context` truncates each message at 1,500 characters. If the decisive
sentence is cut off, say which `message_id` was truncated instead of guessing.

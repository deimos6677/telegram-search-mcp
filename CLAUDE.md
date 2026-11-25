# Claude 项目说明

这个仓库提供一个本地 Telegram / X 聊天检索索引，以及只读 MCP 服务
`telegram-search-mcp`。

处理群聊问题时：

1. 问“今天/最近有什么”时，先调用 `db_stats` 确认最新入库时间，再用
   `recent_messages` 浏览；问具体主题时用 `search_messages`；问路线规划时先用
   `search_wiki` / `read_wiki`（需设置 `TG_INTEL_WIKI_DIR`）。不要凭记忆回答。
2. 再用 `read_context` 打开命中消息的回复链和前后上下文。
3. 知识库笔记是框架，不是证据；回答必须带 `message_id`、时间和发送者，并引用原文。

完整检索纪律见 `SKILL.md`。真实导出和索引放在 `data/`，已被 Git 忽略；
私有群映射与自定义词表通过 `TG_INTEL_CONFIG` 放在仓库外，不要把群 ID、消息正文、手机号、session 或 API key 提交到仓库。

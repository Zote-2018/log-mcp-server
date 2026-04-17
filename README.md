# Log MCP Server

一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的日志查询服务，通过 Kibana 内部 API 查询 Elasticsearch 中的应用日志。

适用于在 Claude Desktop、Cursor 等 AI 编程工具中，通过自然语言直接查询和分析 ELK 日志。

## 功能特性

- **关键字搜索** — 按关键字搜索日志，返回结构化解析结果
- **链路追踪** — 按 sessionId / traceId 查询完整调用链，按时间排序
- **错误聚合** — 查询 ERROR 日志并按错误模式自动分类聚合
- **日志解析** — 自动解析 Logback 格式日志，提取 level、logger、sessionId、errorType 等字段
- **时间范围** — 支持 last_1h、last_6h、last_24h、last_7d 等时间范围

## 前置条件

- Node.js >= 18
- 可访问的 Kibana 实例（需要 Kibana 内部搜索 API）
- Elasticsearch 中存储的 Logback 格式日志

## 安装

```bash
git clone https://github.com/Zote-2018/log-mcp-server.git
cd log-mcp-server
npm install
```

## 配置

### 1. 环境变量

复制 `.env.example` 为 `.env` 并填写实际配置：

```bash
cp .env.example .env
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `KIBANA_URL` | 是 | Kibana 内部搜索 API 地址 |
| `KIBANA_INDEX` | 是 | Elasticsearch 索引名称（如 `logstash-*`） |
| `DEFAULT_CONTAINER` | 否 | 默认容器名称，默认取当前目录名 |

#### KIBANA_URL 配置示例

```
# Kibana 内部 API
KIBANA_URL=http://your-kibana-host:5601/internal/search/es
```

> 注意：需要使用 Kibana 的 **内部 API** 路径 `/internal/search/es`，这是 Kibana 用于执行 Elasticsearch 查询的内部端点。

### 2. 在 Claude Desktop 中配置

编辑 Claude Desktop 的配置文件，添加 MCP Server：

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "log-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/log-mcp-server/dist/index.js"],
      "env": {
        "KIBANA_URL": "http://your-kibana-host:5601/internal/search/es",
        "KIBANA_INDEX": "logstash-*",
        "DEFAULT_CONTAINER": "rag-client"
      }
    }
  }
}
```

### 3. 在 Cursor 中配置

在 Cursor 设置中添加 MCP Server，或编辑 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "log-mcp-server": {
      "command": "node",
      "args": ["./path/to/log-mcp-server/dist/index.js"],
      "env": {
        "KIBANA_URL": "http://your-kibana-host:5601/internal/search/es",
        "KIBANA_INDEX": "logstash-*",
        "DEFAULT_CONTAINER": "rag-client"
      }
    }
  }
}
```

## 使用方法

首次使用前需要先构建项目：

```bash
npm run build
```

### 可用工具

#### `search_logs` — 关键字搜索

按关键字搜索日志，返回结构化日志条目（包含 level、logger、sessionId、errorType、shortMessage）。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 搜索关键字 |
| `time_range` | string | 否 | `last_1h` | 时间范围：`last_1h` / `last_6h` / `last_24h` / `last_7d` |
| `container` | string | 否 | `rag-client` | 容器名称过滤 |
| `limit` | number | 否 | `50` | 最大返回条数（1-200） |

**示例提示词：**

```
搜索最近1小时的 NullPointerException 日志
搜索 rag-client 容器中包含 timeout 的错误
查看最近24小时内关于 database connection 的日志
```

#### `get_trace_logs` — 链路追踪

按 sessionId 或 traceId 查询完整调用链，按时间正序排列，附带统计摘要。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `trace_id` | string | 是 | — | trace_id 或 sessionId |
| `container` | string | 否 | `rag-client` | 容器名称过滤 |

> 自动搜索最近 7 天，最多返回 200 条日志。

**示例提示词：**

```
查询 sessionId 为 abc123-def456 的完整调用链
追踪这个 traceId 的所有日志：550e8400-e29b-41d4
```

#### `get_error_logs` — 错误聚合

查询 ERROR 级别日志，按错误模式自动分类聚合，返回各类错误的数量和示例。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `time_range` | string | 否 | `last_1h` | 时间范围：`last_1h` / `last_6h` / `last_24h` / `last_7d` |
| `container` | string | 否 | `rag-client` | 容器名称过滤 |

**示例提示词：**

```
查看最近1小时的错误日志
最近24小时有哪些类型的错误？
汇总一下今天出现的异常
```

### 推荐使用流程

```
1. get_error_logs  →  了解当前有哪些错误（概览）
2. get_trace_logs  →  选择一个 sessionId 深入追踪（定位）
3. search_logs     →  按关键字搜索更多上下文（分析）
```

## 日志格式

本工具针对标准 Logback 格式进行解析：

```
2026-04-16 20:06:36.739 [http-nio-8080-exec-1] ERROR c.g.app.service.UserService - [getUser,42] NullPointerException: user id is null
    at c.g.app.service.UserService.getUser(UserService.java:42)
sessionId: 550e8400-e29b-41d4-a716-446655440000
```

自动提取的字段：

| 字段 | 来源 |
|------|------|
| `level` | 日志级别（ERROR、WARN、INFO 等） |
| `logger` | Logger 名称（类全限定名） |
| `thread` | 线程名 |
| `sessionId` | 日志中的 sessionId |
| `errorType` | 异常类型（如 NullPointerException） |
| `shortMessage` | 首行消息（截断至 200 字符） |

## 开发

```bash
# 安装依赖
npm install

# 开发模式（直接运行 TypeScript）
npm run dev

# 构建
npm run build

# 运行构建产物
npm start
```

## 技术栈

- **运行时**: Node.js
- **语言**: TypeScript
- **协议**: Model Context Protocol (MCP)
- **依赖**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk), [zod](https://zod.dev)

## License

MIT

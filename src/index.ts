#!/usr/bin/env node

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchLogs } from './es-client.js';
import { parseLog, aggregateErrors, generateTraceSummary } from './log-parser.js';

const server = new McpServer(
  { name: 'log-mcp-server', version: '0.1.0' },
  {
    instructions: [
      'Log MCP Server - 查询 rag-client 应用日志（通过 Kibana 查询 Elasticsearch）',
      '',
      '可用工具:',
      '- search_logs: 按关键字搜索日志，返回结构化结果',
      '- get_trace_logs: 按 sessionId/traceId 查询完整调用链',
      '- get_error_logs: 查询 ERROR 日志并按错误类型聚合',
      '',
      '建议: 先用 get_error_logs 查看错误概览，再用 get_trace_logs 追踪具体会话。',
    ].join('\n'),
  },
);

server.registerTool(
  'search_logs',
  {
    description:
      'Search logs by keyword in Elasticsearch via Kibana. Returns structured log entries with parsed fields (level, logger, sessionId, errorType, shortMessage). Use get_trace_logs for sessionId-based investigation, get_error_logs for error overview.',
    inputSchema: {
      query: z.string().describe('Keywords to search in log messages'),
      time_range: z.string().default('last_1h').describe('Time range: last_1h, last_6h, last_24h, last_7d'),
      container: z.string().default('rag-client').describe('Container name to filter'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max results'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, time_range, container, limit }) => {
    try {
      const result = await searchLogs({ query, timeRange: time_range, container, limit, sortOrder: 'desc' });
      const parsed = result.logs.map(parseLog);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ total: result.total, returned: parsed.length, logs: parsed }, null, 2),
          },
        ],
      };
    } catch (e: any) {
      return { isError: true, content: [{ type: 'text' as const, text: `Search failed: ${e.message}` }] };
    }
  },
);

server.registerTool(
  'get_trace_logs',
  {
    description:
      'Retrieve all logs for a trace_id or sessionId. Searches last 7 days. Returns logs sorted chronologically with a call chain summary. Use when investigating a specific request or session.',
    inputSchema: {
      trace_id: z.string().describe('trace_id or sessionId to search'),
      container: z.string().default('rag-client').describe('Container name filter'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ trace_id, container }) => {
    try {
      const result = await searchLogs({ query: trace_id, timeRange: 'last_7d', container, limit: 200, sortOrder: 'asc' });
      const parsed = result.logs.map(parseLog);
      const summary = generateTraceSummary(parsed);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ trace_id, summary, total: result.total, logs: parsed }, null, 2),
          },
        ],
      };
    } catch (e: any) {
      return { isError: true, content: [{ type: 'text' as const, text: `Trace query failed: ${e.message}` }] };
    }
  },
);

server.registerTool(
  'get_error_logs',
  {
    description:
      'Query ERROR level logs and aggregate by error pattern. Returns error categories with counts and sample messages. Use for error overview, not for keyword search.',
    inputSchema: {
      time_range: z.string().default('last_1h').describe('Time range: last_1h, last_6h, last_24h, last_7d'),
      container: z.string().default('rag-client').describe('Container name filter'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ time_range, container }) => {
    try {
      const result = await searchLogs({ query: 'ERROR', timeRange: time_range, container, limit: 200, sortOrder: 'desc' });
      const parsed = result.logs.map(parseLog);
      const aggregated = aggregateErrors(parsed);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ time_range, total_errors: result.total, error_patterns: aggregated }, null, 2),
          },
        ],
      };
    } catch (e: any) {
      return { isError: true, content: [{ type: 'text' as const, text: `Error query failed: ${e.message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

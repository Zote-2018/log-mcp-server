#!/usr/bin/env node

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchLogs } from './es-client.js';
import { searchLogsKubectl } from './kubectl-client.js';
import { searchLogsK8sApi } from './k8s-api-client.js';
import { parseLog, aggregateErrors, generateTraceSummary } from './log-parser.js';

type BackendType = 'elasticsearch' | 'kubectl' | 'k8s-api-dev' | 'k8s-api-test';
const VALID_BACKENDS = ['elasticsearch', 'kubectl', 'k8s-api-dev', 'k8s-api-test'] as const;

function resolveBackend(explicit?: string): BackendType {
  if (explicit && (VALID_BACKENDS as readonly string[]).includes(explicit)) return explicit as BackendType;
  return (process.env.LOG_BACKEND as BackendType) || 'k8s-api-test';
}

function getSearchFn(backend: BackendType) {
  switch (backend) {
    case 'kubectl': return searchLogsKubectl;
    case 'k8s-api-dev': return (p: any) => searchLogsK8sApi({ ...p, env: 'dev' });
    case 'k8s-api-test': return (p: any) => searchLogsK8sApi({ ...p, env: 'test' });
    default: return searchLogs;
  }
}

const server = new McpServer(
  { name: 'log-mcp-server', version: '0.1.0' },
  {
    instructions: [
      'Log MCP Server - 查询应用日志（支持 Elasticsearch、kubectl、K8s API 三种后端，开发/测试环境）',
      '',
      '## 容器名获取规则',
      '调用任何工具前，必须先读取项目根目录的 .gitlab-ci.yml，从 imageName 变量中提取容器名称：',
      '- imageName 格式为 "$repositoryDir/xxx"，取最后一段（如 openapi-cnfr）作为 container 值',
      '- 若项目有多个 Job（多个 imageName），根据用户关注的模块选择对应的容器名',
      '- 若项目无 .gitlab-ci.yml 或无 imageName，则使用 container 默认值 rag-client',
      '',
      '## 后端选择',
      '- elasticsearch: 通过 Kibana 查询 ES，适用于生产环境',
      '- kubectl: 通过 kubectl logs 查询 k8s 容器日志（需本地 kubeconfig）',
      '- k8s-api-dev: 通过 K8s REST API 查询开发环境容器日志',
      '- k8s-api-test（默认）: 通过 K8s REST API 查询测试环境容器日志',
      '- 可通过 backend 参数指定，或通过 LOG_BACKEND 环境变量配置默认值',
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
      'Search logs by keyword. Returns structured log entries with parsed fields (level, logger, sessionId, errorType, shortMessage). Use get_trace_logs for sessionId-based investigation, get_error_logs for error overview.',
    inputSchema: {
      query: z.string().describe('Keywords to search in log messages'),
      time_range: z.string().default('last_1h').describe('Time range: last_1h, last_6h, last_24h, last_7d'),
      container: z.string().optional().describe('Container name to filter (default: DEFAULT_CONTAINER env or current directory name)'),
      namespace: z.string().optional().describe('Kubernetes namespace / ES index name (e.g. platform-business, rainbow)'),
      backend: z.enum(['elasticsearch', 'kubectl', 'k8s-api-dev', 'k8s-api-test']).optional().describe('Log backend to use. Defaults to LOG_BACKEND env variable.'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max results'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, time_range, container, namespace, backend, limit }) => {
    try {
      const be = resolveBackend(backend);
      const searchFn = getSearchFn(be);
      const result = await searchFn({ query, timeRange: time_range, container, namespace, limit, sortOrder: 'desc' });
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
      container: z.string().optional().describe('Container name to filter (default: DEFAULT_CONTAINER env or current directory name)'),
      namespace: z.string().optional().describe('Kubernetes namespace / ES index name (e.g. platform-business, rainbow)'),
      backend: z.enum(['elasticsearch', 'kubectl', 'k8s-api-dev', 'k8s-api-test']).optional().describe('Log backend to use. Defaults to LOG_BACKEND env variable.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ trace_id, container, namespace, backend }) => {
    try {
      const be = resolveBackend(backend);
      const searchFn = getSearchFn(be);
      const result = await searchFn({ query: trace_id, timeRange: 'last_7d', container, namespace, limit: 200, sortOrder: 'asc' });
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
      container: z.string().optional().describe('Container name to filter (default: DEFAULT_CONTAINER env or current directory name)'),
      namespace: z.string().optional().describe('Kubernetes namespace / ES index name (e.g. platform-business, rainbow)'),
      backend: z.enum(['elasticsearch', 'kubectl', 'k8s-api-dev', 'k8s-api-test']).optional().describe('Log backend to use. Defaults to LOG_BACKEND env variable.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ time_range, container, namespace, backend }) => {
    try {
      const be = resolveBackend(backend);
      const searchFn = getSearchFn(be);
      const result = await searchFn({ query: 'ERROR', timeRange: time_range, container, namespace, limit: 200, sortOrder: 'desc' });
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

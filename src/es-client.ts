import { getCachedNamespace, setCachedNamespace } from './namespace-cache.js';

function getEnv(): { kibanaUrl: string; kibanaIndex: string; defaultContainer: string } {
  const kibanaUrl = process.env.KIBANA_URL!;
  const kibanaIndex = process.env.KIBANA_INDEX!;
  const defaultContainer = process.env.DEFAULT_CONTAINER || basename(process.cwd());
  if (!kibanaUrl) throw new Error('KIBANA_URL is not set in .env');
  if (!kibanaIndex) throw new Error('KIBANA_INDEX is not set in .env');
  return { kibanaUrl, kibanaIndex, defaultContainer };
}

function basename(p: string): string {
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
}

export interface LogEntry {
  timestamp: string;
  container: string;
  pod: string;
  namespace: string;
  message: string;
}

export interface SearchResult {
  total: number;
  logs: LogEntry[];
  /** 实际使用的 ES index name，仅当 namespace 并非调用方显式传入时才附带（cache/default 来源） */
  namespaceUsed?: string;
  namespaceSource?: 'cache' | 'default';
  /** total=0 时给出的排查提示 */
  cacheHint?: string;
}

/** 将 SearchResult 里的 namespace 元信息拼成响应可用的字段，explicit 来源不附带任何字段 */
export function namespaceMeta(result: SearchResult): Record<string, string> {
  const meta: Record<string, string> = {};
  if (result.namespaceUsed && result.namespaceSource) {
    meta.namespace_used = result.namespaceUsed;
    meta.namespace_source = result.namespaceSource;
  }
  if (result.cacheHint) meta.cache_hint = result.cacheHint;
  return meta;
}

function parseTimeRange(timeRange: string): { gte: string; lte: string } {
  const now = new Date();
  const lte = now.toISOString();
  let gte: Date;

  const match = timeRange.match(/^last_(\d+)([hdm])$/);
  if (!match) {
    gte = new Date(now.getTime() - 3600000);
  } else {
    const value = parseInt(match[1]);
    const unit = match[2];
    const ms = { h: 3600000, d: 86400000, m: 60000 }[unit] ?? 3600000;
    gte = new Date(now.getTime() - value * ms);
  }

  return { gte: gte.toISOString(), lte };
}

export async function searchLogs(params: {
  query?: string;
  timeRange?: string;
  container?: string;
  namespace?: string;
  limit?: number;
  sortOrder?: 'desc' | 'asc';
}): Promise<SearchResult> {
  const {
    query,
    timeRange = 'last_1h',
    container,
    limit = 50,
    sortOrder = 'desc',
  } = params;
  const { kibanaUrl, kibanaIndex, defaultContainer } = getEnv();
  const effectiveContainer = container || defaultContainer;
  // namespace 同时作为 ES index 名（与 K8s namespace 一致）
  // 解析优先级：显式传入 > server 端缓存(按 container) > .env 默认值
  const explicitNamespace = params.namespace?.trim() || undefined;
  let effectiveIndex: string;
  let namespaceSource: 'cache' | 'default' | undefined;
  if (explicitNamespace) {
    effectiveIndex = explicitNamespace;
  } else {
    const cached = getCachedNamespace(effectiveContainer);
    if (cached) {
      effectiveIndex = cached;
      namespaceSource = 'cache';
    } else {
      effectiveIndex = kibanaIndex;
      namespaceSource = 'default';
    }
  }

  const time = parseTimeRange(timeRange);
  const filters: object[] = [{ match_all: {} }];

  if (effectiveContainer) {
    filters.push({ match_phrase: { container: effectiveContainer } });
  }
  if (query) {
    filters.push({ match_phrase: { message: query } });
  }
  filters.push({
    range: {
      timestamp: { gte: time.gte, lte: time.lte, format: 'strict_date_optional_time' },
    },
  });

  const body = {
    params: {
      index: effectiveIndex,
      body: {
        version: true,
        size: Math.min(limit, 500),
        sort: [{ timestamp: { order: sortOrder, unmapped_type: 'boolean' } }],
        stored_fields: ['*'],
        docvalue_fields: [{ field: 'timestamp', format: 'date_time' }],
        _source: { excludes: [] },
        query: { bool: { must: [], filter: filters, should: [], must_not: [] } },
      },
    },
  };

  const resp = await fetch(kibanaUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'kbn-version': '7.10.2' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Kibana ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  const hits: any[] = data?.rawResponse?.hits?.hits ?? [];
  const total: number = data?.rawResponse?.hits?.total ?? 0;

  const logs: LogEntry[] = hits.map((h: any) => ({
    timestamp: h._source?.timestamp ?? '',
    container: h._source?.container ?? '',
    pod: h._source?.pod ?? '',
    namespace: h._source?.namespace ?? '',
    message: h._source?.message ?? '',
  }));

  // 显式传入的 namespace 一旦查询命中(total>0)，即视为已验证，记入 server 端缓存供后续直接复用
  if (explicitNamespace && total > 0) {
    setCachedNamespace(effectiveContainer, explicitNamespace);
  }

  const result: SearchResult = { total, logs };
  if (namespaceSource) {
    result.namespaceUsed = effectiveIndex;
    result.namespaceSource = namespaceSource;
    if (total === 0) {
      result.cacheHint =
        namespaceSource === 'cache'
          ? `Cached namespace '${effectiveIndex}' for container '${effectiveContainer}' returned no results. If the ES index was migrated, pass the correct namespace explicitly to refresh the cache.`
          : `No cached namespace for container '${effectiveContainer}', used default index '${effectiveIndex}'. If this container logs to a different ES index, ask the user for the correct name and retry with an explicit namespace parameter — it will be cached automatically on success.`;
    }
  }
  return result;
}

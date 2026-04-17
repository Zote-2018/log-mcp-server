const KIBANA_URL = process.env.KIBANA_URL!;
const KIBANA_INDEX = process.env.KIBANA_INDEX!;
const DEFAULT_CONTAINER = process.env.DEFAULT_CONTAINER || basename(process.cwd());

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
  limit?: number;
  sortOrder?: 'desc' | 'asc';
}): Promise<SearchResult> {
  const {
    query,
    timeRange = 'last_1h',
    container = DEFAULT_CONTAINER,
    limit = 50,
    sortOrder = 'desc',
  } = params;

  const time = parseTimeRange(timeRange);
  const filters: object[] = [{ match_all: {} }];

  if (container) {
    filters.push({ match_phrase: { container } });
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
      index: KIBANA_INDEX,
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

  const resp = await fetch(KIBANA_URL, {
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

  return { total, logs };
}

import type { LogEntry } from './es-client.js';

export interface ParsedLog extends LogEntry {
  level?: string;
  logger?: string;
  thread?: string;
  sessionId?: string;
  errorType?: string;
  shortMessage?: string;
}

// Logback: 2026-04-16 20:06:36.739 [thread] LEVEL logger - [method,line]  message
const LOGBACK_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[([^\]]+)\] (\w+) (\S+) - \[([^\]]+)\]\s+([\s\S]*)/;
const SESSION_RE = /sessionId[：:]\s*([a-f0-9-]+)/;
const EXCEPTION_RE = /^(?:Caused by: )?([\w.]+(?:Error|Exception))\b/m;

export function parseLog(entry: LogEntry): ParsedLog {
  const result: ParsedLog = { ...entry };
  const m = entry.message.match(LOGBACK_RE);
  if (!m) return result;

  result.level = m[3];
  result.logger = m[4];
  result.thread = m[2];

  const content = m[6];

  const session = content.match(SESSION_RE);
  if (session) result.sessionId = session[1];

  const exc = content.match(EXCEPTION_RE);
  if (exc) result.errorType = exc[1];

  const firstLine = content.split('\n')[0].trim();
  result.shortMessage = firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;

  return result;
}

export function aggregateErrors(logs: ParsedLog[]): { pattern: string; count: number; sample: string; errorType?: string }[] {
  const map = new Map<string, { count: number; sample: string; errorType?: string }>();

  for (const log of logs) {
    const key = log.errorType || log.shortMessage || 'unknown';
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, {
        count: 1,
        sample: log.shortMessage || log.message.slice(0, 200),
        errorType: log.errorType,
      });
    }
  }

  return [...map.entries()]
    .map(([pattern, data]) => ({ pattern, ...data }))
    .sort((a, b) => b.count - a.count);
}

export function generateTraceSummary(logs: ParsedLog[]): string {
  if (logs.length === 0) return '无相关日志';

  const first = logs[0];
  const last = logs[logs.length - 1];
  const parts = [`共 ${logs.length} 条日志`];

  if (first.timestamp !== last.timestamp) {
    parts.push(`时间范围: ${first.timestamp} ~ ${last.timestamp}`);
  }

  const levels: Record<string, number> = {};
  for (const l of logs) {
    const lv = l.level || 'UNKNOWN';
    levels[lv] = (levels[lv] || 0) + 1;
  }
  parts.push(`日志级别: ${Object.entries(levels).map(([k, v]) => `${k}:${v}`).join(', ')}`);

  const errorTypes = [...new Set(logs.map(l => l.errorType).filter(Boolean))];
  if (errorTypes.length > 0) {
    parts.push(`异常类型: ${errorTypes.join(', ')}`);
  }

  return parts.join('\n');
}

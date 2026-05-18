import http from 'http';
import https from 'https';
import type { LogEntry, SearchResult } from './es-client.js';

const LABEL_KEYS = ['app', 'app.kubernetes.io/name', 'k8s.kuboard.cn/name'];

interface K8sApiConfig {
  apiUrl: string;
  token: string;
  skipTls: boolean;
}

interface ResolvedPods {
  namespace: string;
  podNames: string[];
}

type K8sEnv = 'dev' | 'test';

function getConfig(env: K8sEnv): K8sApiConfig {
  const prefix = env === 'dev' ? 'DEV' : 'TEST';
  const apiUrl = process.env[`${prefix}_K8S_API_URL`];
  const token = process.env[`${prefix}_K8S_API_TOKEN`];
  if (!apiUrl) throw new Error(`${prefix}_K8S_API_URL is required for ${env} environment.`);
  if (!token) throw new Error(`${prefix}_K8S_API_TOKEN is required for ${env} environment.`);
  const skipTls = process.env.K8S_API_SKIP_TLS !== 'false';
  return { apiUrl, token, skipTls };
}

function k8sApiRequest(config: K8sApiConfig, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.apiUrl);
    const isHttps = config.apiUrl.startsWith('https://');
    const mod = isHttps ? https : http;
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
      },
    };
    if (isHttps) {
      options.rejectUnauthorized = !config.skipTls;
    }
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`K8s API ${res.statusCode}: Token may be expired or insufficient permissions. Try refreshing the Dashboard token.`));
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`K8s API ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', (e) => {
      if (e.message.includes('CERT') || e.message.includes('certificate') || e.message.includes('TLS')) {
        reject(new Error(`TLS error: ${e.message}. Set K8S_API_SKIP_TLS=true to skip certificate verification.`));
        return;
      }
      reject(e);
    });
    req.end();
  });
}

function podMatchesContainer(pod: any, container: string): boolean {
  const labels = pod.metadata?.labels || {};
  if (LABEL_KEYS.some(k => labels[k] === container)) return true;

  const containers = pod.spec?.containers || [];
  if (containers.some((c: any) => c.name === container)) return true;

  return false;
}

async function discoverPods(config: K8sApiConfig, container: string, explicitNamespace?: string): Promise<ResolvedPods> {
  const path = explicitNamespace
    ? `/api/v1/namespaces/${explicitNamespace}/pods?fieldSelector=status.phase==Running`
    : '/api/v1/pods?fieldSelector=status.phase==Running';

  const raw = await k8sApiRequest(config, path);
  const podList = JSON.parse(raw);
  const matched = (podList.items || []).filter((pod: any) => podMatchesContainer(pod, container));

  if (matched.length === 0) {
    throw new Error(
      `No running pod found for "${container}" via K8s API. Checked labels: [${LABEL_KEYS.join(', ')}] and spec.containers[].name.`,
    );
  }

  const namespace = explicitNamespace || matched[0].metadata.namespace;
  const podsInNs = matched
    .filter((p: any) => p.metadata.namespace === namespace)
    .map((p: any) => p.metadata.name);

  if (podsInNs.length === 0) {
    throw new Error(`No running pod for "${container}" in namespace "${namespace}". Found in: ${[...new Set(matched.map((p: any) => p.metadata.namespace))].join(', ')}`);
  }

  return { namespace, podNames: podsInNs };
}

async function fetchPodLogs(config: K8sApiConfig, namespace: string, podName: string, sinceTime: string, tailLines: number): Promise<string> {
  const path = `/api/v1/namespaces/${namespace}/pods/${podName}/log?timestamps=true&tailLines=${tailLines}&sinceTime=${sinceTime}`;
  const raw = await k8sApiRequest(config, path);
  return raw;
}

const K8S_LOG_LINE_RE = /^(\S+)\s+([\s\S]*)$/;

function parseK8sApiLogs(rawLogs: string, podName: string, namespace: string, container: string): LogEntry[] {
  return rawLogs.split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = line.match(K8S_LOG_LINE_RE);
      if (m) {
        return { timestamp: m[1], container, pod: podName, namespace, message: m[2] };
      }
      return { timestamp: '', container, pod: podName, namespace, message: line };
    });
}

function parseTimeRange(timeRange: string): string {
  const now = new Date();
  const match = timeRange.match(/^last_(\d+)([hdm])$/);
  if (!match) return now.toISOString();
  const value = parseInt(match[1]);
  const unit = match[2];
  const ms = { h: 3600000, d: 86400000, m: 60000 }[unit] ?? 3600000;
  return new Date(now.getTime() - value * ms).toISOString();
}

export async function searchLogsK8sApi(params: {
  query?: string;
  timeRange?: string;
  container?: string;
  namespace?: string;
  limit?: number;
  sortOrder?: 'desc' | 'asc';
  env?: K8sEnv;
}): Promise<SearchResult> {
  const {
    query,
    timeRange = 'last_1h',
    container = process.env.DEFAULT_CONTAINER || '',
    namespace,
    limit = 50,
    sortOrder = 'desc',
    env = 'test',
  } = params;

  if (!container) throw new Error('container is required for k8s-api backend');

  const config = getConfig(env);
  const target = await discoverPods(config, container, namespace);
  const sinceTime = parseTimeRange(timeRange);

  const allLogs = await Promise.all(
    target.podNames.map((podName) =>
      fetchPodLogs(config, target.namespace, podName, sinceTime, 1000).then((raw) =>
        parseK8sApiLogs(raw, podName, target.namespace, container),
      ),
    ),
  );

  let logs = allLogs.flat();

  if (query) {
    const q = query.toLowerCase();
    logs = logs.filter((l) => l.message.toLowerCase().includes(q));
  }

  logs.sort((a, b) => {
    const cmp = a.timestamp.localeCompare(b.timestamp);
    return sortOrder === 'desc' ? -cmp : cmp;
  });

  const total = logs.length;
  logs = logs.slice(0, Math.min(limit, 500));

  return { total, logs };
}

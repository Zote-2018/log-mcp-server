import { execFile } from 'child_process';
import { promisify } from 'util';
import type { LogEntry, SearchResult } from './es-client.js';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024;

const LABEL_KEYS = ['app', 'app.kubernetes.io/name', 'k8s.kuboard.cn/name'];

interface ResolvedTarget {
  namespace: string;
  pods: string[];
  labelSelector?: string;
}

function podMatchesContainer(pod: any, container: string): boolean {
  const labels = pod.metadata?.labels || {};
  if (LABEL_KEYS.some(k => labels[k] === container)) return true;

  const containers = pod.spec?.containers || [];
  if (containers.some((c: any) => c.name === container)) return true;

  return false;
}

async function discoverTarget(container: string, explicitNamespace?: string): Promise<ResolvedTarget> {
  const envNs = process.env.K8S_NAMESPACE;
  const envLabel = process.env.K8S_LABEL_SELECTOR;

  // 用户传了 namespace 且配了 label selector → 直接用
  if (explicitNamespace && envLabel) {
    return { namespace: explicitNamespace, pods: [], labelSelector: envLabel };
  }
  // 环境变量都配了 → 直接用
  if (envNs && envLabel) {
    return { namespace: envNs, pods: [], labelSelector: envLabel };
  }

  // 自动发现：跨所有命名空间查找 pod
  let stdout: string;
  try {
    const result = await execFileAsync('kubectl', [
      'get', 'pods', '-A', '-o', 'json',
      '--field-selector=status.phase=Running',
    ], { maxBuffer: MAX_BUFFER });
    stdout = result.stdout;
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new Error('kubectl not found. Install kubectl or use the elasticsearch backend.');
    throw new Error(`kubectl get pods failed: ${e.message}`);
  }

  const podList = JSON.parse(stdout);
  const matched = (podList.items || []).filter((pod: any) => podMatchesContainer(pod, container));

  if (matched.length === 0) {
    throw new Error(
      `No running pod found for "${container}". Checked labels: [${LABEL_KEYS.join(', ')}] and spec.containers[].name across all namespaces.`,
    );
  }

  const namespace = explicitNamespace || envNs || matched[0].metadata.namespace;
  const podsInNs = matched
    .filter((p: any) => p.metadata.namespace === namespace)
    .map((p: any) => p.metadata.name);

  if (podsInNs.length === 0) {
    throw new Error(`No running pod for "${container}" in namespace "${namespace}". Found in: ${[...new Set(matched.map((p: any) => p.metadata.namespace))].join(', ')}`);
  }

  return { namespace, pods: podsInNs };
}

function parseTimeRange(timeRange: string): string {
  const now = new Date();
  const match = timeRange.match(/^last_(\d+)([hdm])$/);
  if (!match) return new Date(now.getTime() - 3600000).toISOString();
  const value = parseInt(match[1]);
  const unit = match[2];
  const ms = { h: 3600000, d: 86400000, m: 60000 }[unit] ?? 3600000;
  return new Date(now.getTime() - value * ms).toISOString();
}

const KUBECTL_PREFIX_LINE_RE = /^(\S+)\s+\[([^\]]+)\]\s+([\s\S]*)$/;
const KUBECTL_TIMESTAMP_RE = /^(\S+)\s+([\s\S]*)$/;

function parseKubectlOutput(rawOutput: string, container: string, namespace: string, podNames?: string[]): LogEntry[] {
  const lines = rawOutput.split('\n').filter(Boolean);
  if (podNames && podNames.length > 0) {
    // 自动发现模式：无 --prefix，直接用 pod 名称
    const pod = podNames[0];
    return lines.map((line) => {
      const m = line.match(KUBECTL_TIMESTAMP_RE);
      if (m) {
        return { timestamp: m[1], container, pod, namespace, message: m[2] };
      }
      return { timestamp: '', container, pod, namespace, message: line };
    });
  }
  // label selector 模式：有 --prefix，格式为 timestamp [pod] message
  return lines.map((line) => {
    const m = line.match(KUBECTL_PREFIX_LINE_RE);
    if (m) {
      return { timestamp: m[1], container, pod: m[2], namespace, message: m[3] };
    }
    return { timestamp: '', container, pod: '', namespace, message: line };
  });
}

function buildKubectlArgs(target: ResolvedTarget, sinceTime: string): string[] {
  const args = ['logs', '--timestamps', '-n', target.namespace, '--since-time', sinceTime, '--tail', '1000'];
  if (target.pods.length > 0) {
    // 有明确 pod 名称时不需要 --prefix，直接用 pod 名称
    args.push(...target.pods);
  } else if (target.labelSelector) {
    // label selector 时加 --prefix 区分不同 pod
    args.push('--prefix', '-l', target.labelSelector);
  }
  const context = process.env.K8S_CONTEXT;
  if (context) args.push('--context', context);
  return args;
}

export async function searchLogsKubectl(params: {
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
    container = process.env.DEFAULT_CONTAINER || '',
    namespace,
    limit = 50,
    sortOrder = 'desc',
  } = params;

  if (!container) throw new Error('container is required for kubectl backend');

  const target = await discoverTarget(container, namespace);
  const sinceTime = parseTimeRange(timeRange);
  const args = buildKubectlArgs(target, sinceTime);

  let stdout: string;
  try {
    const result = await execFileAsync('kubectl', args, { maxBuffer: MAX_BUFFER });
    stdout = result.stdout;
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new Error('kubectl not found. Install kubectl or use the elasticsearch backend.');
    throw new Error(`kubectl failed: ${e.message}`);
  }

  let logs = parseKubectlOutput(stdout, container, target.namespace,
    target.pods.length > 0 ? target.pods : undefined);

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

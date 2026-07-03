import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';

// 全局缓存:用户主目录下 ~/.config/log-mcp-server/log-mcp.json
// 跨项目共用一份,按 container 索引
const CACHE_PATH = resolve(homedir(), '.config/log-mcp-server/log-mcp.json');

type NamespaceMap = Record<string, string>;

function readCache(): NamespaceMap {
  try {
    if (!existsSync(CACHE_PATH)) return {};
    return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as NamespaceMap;
  } catch {
    // 文件不存在/JSON 损坏时按空缓存处理,不影响正常查询
    return {};
  }
}

function writeCache(map: NamespaceMap): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // 先写临时文件再 rename,避免进程崩溃/磁盘写满导致 JSON 半写损坏
  const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(map, null, 2), 'utf-8');
  renameSync(tmpPath, CACHE_PATH);
}

/** 读取某个 container 已缓存的 ES namespace(index name),未命中返回 undefined */
export function getCachedNamespace(container: string): string | undefined {
  if (!container) return undefined;
  return readCache()[container];
}

/** 记住 container -> namespace 映射。值未变化时跳过写盘 */
export function setCachedNamespace(container: string, namespace: string): void {
  if (!container || !namespace) return;
  const map = readCache();
  if (map[container] === namespace) return;
  map[container] = namespace;
  writeCache(map);
}

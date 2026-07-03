#!/usr/bin/env node
/**
 * 一次性脚本：从测试 K8s 集群抓取常用 namespace 下的 Running Pod，
 * 提取 container name，按 container -> namespace 写入全局缓存。
 *
 * 使用 server 自己的 setCachedNamespace() 保证写入路径与运行时一致。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { setCachedNamespace } from '../src/namespace-cache.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

const API_URL = process.env.TEST_K8S_API_URL;
const TOKEN = process.env.TEST_K8S_API_TOKEN;
const NAMESPACES = ['rainbow', 'agent-service', 'platform-business', 'platform-core'];
const LABEL_KEYS = ['app', 'app.kubernetes.io/name', 'k8s.kuboard.cn/name'];

if (!API_URL || !TOKEN) {
  console.error('TEST_K8S_API_URL / TEST_K8S_API_TOKEN missing in .env');
  process.exit(1);
}

async function listPods(ns: string): Promise<any[]> {
  const url = `${API_URL}/api/v1/namespaces/${ns}/pods?fieldSelector=status.phase==Running`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`${ns}: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as any;
  return data.items || [];
}

function extractContainerNames(pod: any): string[] {
  const names = new Set<string>();
  const labels = pod.metadata?.labels || {};
  for (const k of LABEL_KEYS) {
    if (labels[k]) names.add(labels[k]);
  }
  for (const c of pod.spec?.containers || []) {
    if (c.name) names.add(c.name);
  }
  return [...names];
}

(async () => {
  const summary: Record<string, string[]> = {};
  for (const ns of NAMESPACES) {
    try {
      const pods = await listPods(ns);
      const containers = new Set<string>();
      for (const pod of pods) {
        for (const name of extractContainerNames(pod)) {
          containers.add(name);
        }
      }
      const list = [...containers].sort();
      summary[ns] = list;
      for (const c of list) {
        setCachedNamespace(c, ns);
      }
      console.log(`${ns}: ${list.length} containers -> ${list.join(', ')}`);
    } catch (e: any) {
      console.error(`${ns} FAILED: ${e.message}`);
    }
  }
  console.log('\nDone. Cache updated.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

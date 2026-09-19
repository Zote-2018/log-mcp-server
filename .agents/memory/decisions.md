# 决策记录（decisions）

条目格式：`### YYYY-MM-DD 标题` + 背景/决策/理由。

### 2026-09-18 四后端架构与 namespace 服务端缓存（已落地）
- 四查询后端：elasticsearch（生产，经 Kibana 内部 API，Cookie/kibana.token 认证）、kubectl（本地 kubeconfig）、k8s-api-dev / k8s-api-test（ServiceAccount Token 认证）
- 落地提交：badbd0a（新增 kubectl + K8s API 后端）、2d09818（ES namespace server 端缓存，container→index 映射跨会话自动记忆）
- LOG_BACKEND 默认 elasticsearch；代码在 src/{es-client,kubectl-client,k8s-api-client,namespace-cache}.ts

### 2026-09-18 架构细节全集（迁移自旧 Claude 记忆完整版，经代码核实）
- ServiceAccount Token 方案：k8s-api 后端用 rainbow-viewer 只读 ServiceAccount Token（集群管理员经 Kuboard 创建），权限最小化；dev/test 分别用 DEV_K8S_*/TEST_K8S_* 前缀环境变量
- namespace 参数复用为 ES index 名：显式传 namespace 即选 index；ES 后端选定 index 后不再追加 namespace match_phrase 过滤
- namespace server 端缓存（src/namespace-cache.ts）：路径 ~/.config/log-mcp-server/log-mcp.json（os.homedir()），扁平 {container: namespace} 全项目共用，先写临时文件再 renameSync 原子落盘；解析优先级 显式 namespace > 缓存 > .env KIBANA_INDEX；仅显式传入且 total>0 才写缓存；total=0 不淘汰（响应附 cache_hint 提示显式重试覆盖）；namespace_used/namespace_source 仅非显式传入时返回。取代早期"AI 客户端读写项目内缓存文件"方案。预填脚本 scripts/seed-namespace-cache.ts
- 同名 container 冲突决策：扁平结构后写覆盖前，openapi-cnfr/quote/vault 缓存指向 platform-business；查 agent-service 下同名服务须显式传 namespace=agent-service（用户选择保持现状）
- Pod 自动发现：显式 namespace+label selector → 环境变量 → 全命名空间扫描 Running pod，LABEL_KEYS=['app','app.kubernetes.io/name','k8s.kuboard.cn/name'] 加 spec.containers[].name 匹配（kubectl-client.ts/k8s-api-client.ts）
- DEFAULT_CONTAINER 自动取项目目录名：es-client.ts 用 basename(process.cwd()) 兜底，去掉硬编码 rag-client
- .env 加载基于脚本路径：src/index.ts 用 import.meta.url 定位 ../.env（不依赖 cwd），曾因 ES 模块 import 提升导致 dotenv 时序问题已修复（8f8afc5）
- 三工具：search_logs / get_trace_logs / get_error_logs（registerTool）

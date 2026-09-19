# 已知问题（known-issues）

条目：`### YYYY-MM-DD 标题`，症状/根因/规避。

### 2026-09-18 已知问题清单（迁移自旧 Claude 记忆，经代码核实仍有效）
- kubectl logs --prefix 输出格式差异：label selector 场景（带 --prefix）与自动发现场景（不带）格式不同，已双格式解析修复，kubectl 升级需回归
- ServiceAccount Token 过期无自动刷新，长期运行后 k8s-api 后端会失效
- 无任何测试覆盖（无 tests/ 目录）
- any 类型散布于 src/index.ts（getSearchFn）、es-client.ts、k8s-api-client.ts、kubectl-client.ts
- npm 全局安装（npm link）偶发权限问题

### 2026-09-18 已知问题补充（迁移自旧 Claude 记忆完整版）
- Kuboard SSO Token 不能调 K8s API：v3 SSO Token audience 是 kuboard-sso，直接用返回 401，必须用 ServiceAccount Token（rainbow-viewer）
- 测试环境 ServiceAccount Token 复制时末尾若多 `+` 字符会导致 401
- 类型定义位置不理想：k8s-api-client.ts / kubectl-client.ts 从 es-client.ts import 类型（ES 客户端不应是其他后端的类型来源），不影响功能
- namespace 缓存同名 container 后写覆盖前（见 decisions 同名冲突条），无自动消歧
- MCP server 是常驻进程：npm run build 后必须重启 MCP server（重启 Claude Code 或 /mcp）才加载新代码
- 环境地址备忘：生产 Kibana http://124.71.193.17:31090（Cookie 认证）；开发 K8s API https://192.168.1.91:6443；测试 K8s API https://10.78.10.138:5443（均为 rainbow-viewer Token，自签名证书 K8S_API_SKIP_TLS 默认 true）；测试集群 Kuboard v3 管理 http://10.68.221.145:8080

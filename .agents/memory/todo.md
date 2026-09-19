# 待办（todo）

条目格式：`### YYYY-MM-DD 标题`，完成后删除或移入 decisions。

### 2026-09-18 待办清单（迁移自旧 Claude 记忆，经代码核实仍有效）
- [ ] 补充单元测试和集成测试（当前无 tests/ 目录，零测试覆盖）
- [ ] 消除 TypeScript any 类型（src/index.ts getSearchFn、k8s-api-client.ts、kubectl-client.ts、es-client.ts 均有）
- [ ] search_logs 增加分页能力（当前单次最大 200 条）
- [ ] ServiceAccount Token 过期后自动刷新机制
- [ ] package.json 添加 bin 字段，支持全局命令行入口
- [ ] README 更新四后端说明（README 仍写"两种查询后端"，backend 参数只列 elasticsearch/kubectl，实际四种）
- [ ] README 的 LOG_BACKEND 默认值与代码不符：README 写 elasticsearch，代码实际默认 k8s-api-test（src/index.ts:21）
- [ ] 提交 2b6c543（.gitignore 加 .omo/）待推送，当前 master ahead 1

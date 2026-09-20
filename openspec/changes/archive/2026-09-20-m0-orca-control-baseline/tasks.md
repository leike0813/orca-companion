## 1. 应用契约与 Orca 操作目录

- [x] 1.1 实现 IP-1：在 `src/application/ports/execution-backend.ts` 与 `src/application/dto/operation-outcome.ts` 定义 `ExecutionBackend`、`ExecutionScope`、`OperationRef` 与三值 `OperationOutcome<T>`，使 `mutate` 的 scope 为必填；运行 `pnpm typecheck`
- [x] 1.2 实现 IP-2：在 `src/adapters/orca-cli/operation-catalog.ts` 登记 M0 首批命令，在 `orca-backend.ts` 实现封闭解析与三值分类、在 `error-classification.ts` 实现 D3 错误映射与 unknown 对账路径；运行 `pnpm test -- tests/orca-backend.contract.test.ts`

## 2. 进程边界与投递传输

- [x] 2.1 实现 IP-3：在 `src/adapters/orca-cli/process-runner.ts` 实现参数数组执行、必填 cwd/env、stdout 与 stderr 分离、字节与行数上限加截断标记、有限超时与取消；运行 `pnpm test -- tests/process-runner.test.ts`
- [x] 2.2 实现 IP-4：在 `delivery-reader.ts` 实现分离的 `readDeliveryBatch`、`ackDelivery` 与稳定 `DeliveryIdentity`，读取不得隐式确认或执行业务落盘；运行 `pnpm test -- tests/delivery-transport.test.ts`

## 3. CLI 入口与 doctor

- [x] 3.1 实现 IP-5：在 `src/bootstrap/doctor.ts` 与 `src/interfaces/cli/doctor-command.ts` 实现环境与能力核验，区分不可达、版本不符与能力缺失，缺失时非零退出；运行 `pnpm test -- tests/doctor.test.ts`
- [x] 3.2 实现 IP-6：在 `src/interfaces/cli/main.ts` 与 `package.json` 注册 `orca-companion` 入口并补 `build` 脚本，保证无 TTY 可运行；运行 `pnpm build`

## 4. 行为测试

- [x] 4.1 实现 IP-7：补齐 `tests/process-runner.test.ts` 覆盖特殊字符参数、stderr 保活噪声与截断标记；运行 `pnpm test -- tests/process-runner.test.ts`
- [x] 4.2 实现 IP-8：补齐 `tests/orca-backend.contract.test.ts` 覆盖未声明操作、缺失 scope、三值分类、原 ID 对账与阻塞路径；运行 `pnpm test -- tests/orca-backend.contract.test.ts`
- [x] 4.3 实现 IP-9：补齐 `tests/delivery-transport.test.ts` 覆盖读取零确认、身份字段保留与独立确认的三值结果；运行 `pnpm test -- tests/delivery-transport.test.ts`
- [x] 4.4 实现 IP-10：补齐 `tests/doctor.test.ts` 覆盖成功、无 TTY、身份不可取得、版本或 runtime 不可用；运行 `pnpm test -- tests/doctor.test.ts`

## 5. 隔离真实探针与文档回写

- [x] 5.1 实现 IP-11：编写 `tests/m0-isolated-probe.integration.test.ts`，默认跳过并仅在 `ORCA_M0_PROBE=1` 时在一次性仓库与专用身份中运行闭环；真实 Codex Worker 的 Worker Profile 必须显式绑定 `minimax-cn/MiniMax-M3`，缺少绑定时在派发前失败；运行 `ORCA_M0_PROBE=1 pnpm test -- tests/m0-isolated-probe.integration.test.ts`
- [x] 5.2 实现 IP-12：按探针结论更新 `docs/orca-compatibility.md` 的验证环境、已核验与尚未验证三节并记录缺口；运行 `rg -n "尚未验证" docs/orca-compatibility.md`
- [x] 5.3 交付核对：确认 M0 门禁结论已记录；若协调者身份硬门失败，则说明 `m1-persist-coordination-state` 及其后 change 停止实施；运行 `pnpm typecheck && pnpm lint && pnpm test`

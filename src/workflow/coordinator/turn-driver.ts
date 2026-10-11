/**
 * 共用的单次轮次驱动：协调宿主与调试宿主调用同一份实现。
 *
 * 它只拥有「一次请求能不能发出、结束后停在哪个状态」这件事，不认识 graph 的节点与状态名——
 * 图结局到轮次结局的映射由宿主在 `execute` 里完成。
 */
import type { CoordinatorSessionId } from '../../application/dto/identity.js';
import type {
  AgentTurnExecution,
  AgentTurnFailure,
  AgentTurnFailureCode,
  AgentTurnPort,
  AgentTurnRetryOutcome,
  AgentTurnRunOutcome,
  AgentTurnState,
} from '../../application/ports/agent-turn.js';
import { AGENT_TURN_MESSAGE_CHARS } from '../../application/ports/agent-turn.js';

export type AgentTurnDriverOptions = {
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly turns: AgentTurnPort;
  readonly execute: AgentTurnExecution;
  /** 宿主已有的取消信号（如 session.modelAbort）：它 abort 时本驱动同步停止。 */
  readonly bridgeSignal?: AbortSignal;
  /** 进程正在退出时为 true：不再写可能已关闭的存储，也不再发起请求。 */
  readonly isClosing?: () => boolean;
  readonly onStateChange?: (state: AgentTurnState) => void;
  /**
   * 把抛出的异常转成可持久化的诊断。默认只保留错误类型名：provider 原始消息可能带响应体、
   * 请求头或凭据片段；宿主需要更细的诊断时在这里显式脱敏后返回。
   */
  readonly describeError?: (error: unknown) => string;
};

const failureOf = (code: AgentTurnFailureCode, message: string): AgentTurnFailure => ({
  code,
  message: message.slice(0, AGENT_TURN_MESSAGE_CHARS),
});

const stopped = (failure: AgentTurnFailure): AgentTurnRunOutcome => ({ kind: 'stopped', failure });
const rejected = (failure: AgentTurnFailure): AgentTurnRetryOutcome => ({ kind: 'rejected', failure });

export class AgentTurnDriver {
  readonly coordinatorSessionId: CoordinatorSessionId;
  private readonly turns: AgentTurnPort;
  private readonly execute: AgentTurnExecution;
  private readonly isClosing: () => boolean;
  private readonly describeError: (error: unknown) => string;
  private readonly onStateChange: (state: AgentTurnState) => void;
  private latch: AgentTurnFailure | null = null;
  private active = false;
  private controller: AbortController | null = null;
  private stopRevision = 0;

  constructor(options: AgentTurnDriverOptions) {
    this.coordinatorSessionId = options.coordinatorSessionId;
    this.turns = options.turns;
    this.execute = options.execute;
    this.isClosing = options.isClosing ?? (() => false);
    this.onStateChange = options.onStateChange ?? (() => {});
    this.describeError = options.describeError
      ?? ((error: unknown) => (error instanceof Error ? error.name : typeof error));
    // 构造即读取持久状态：running 说明上次进程在请求途中消失，halted 说明故障待用户处理，
    // 两者都要经过明确恢复，因此在这里就上 latch，不等第一次 invoke 才补。
    this.sync();
    options.bridgeSignal?.addEventListener('abort', () => {
      this.controller?.abort();
      if (!this.halted) this.stop();
    }, { once: true });
  }

  /** 本进程是否已停止：宿主的 invoke、pendingWake、定时 wake 与 maintenance 入口都要先问它。 */
  get halted(): boolean {
    if (this.latch !== null) return true;
    // 维护与自动入口只读这一个布尔值，因此它必须自己 fail closed：重读失败或 durable 仍有未结束
    // 轮次时同样上 latch，而不是让宿主在读不到状态时继续发请求。
    if (this.active) return false;
    this.sync();
    return this.latch !== null;
  }

  /** 在途轮次的取消信号；宿主把它交给图调用即可接管取消。 */
  get signal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }

  /** 当前可见状态：latch 优先，其次在途轮次，最后重读持久状态（读不到即按停止处理）。 */
  get state(): AgentTurnState {
    if (this.latch !== null) return { kind: 'halted', failure: this.latch };
    if (this.active) return { kind: 'running' };
    return this.sync();
  }

  /**
   * 跑一次轮次。
   *
   * 请求只有在 `running` 落盘成功之后才发出：落盘失败本身也是一次停止，不能因为先跑再记，让
   * 下一轮对账把同一份未完成工作再发一次。退出期间不发起请求——那既没有 running 记录，也没有
   * 接收它的会话。
   */
  async run(): Promise<AgentTurnRunOutcome> {
    if (this.active) return stopped(failureOf('stopped', '本实例已有活跃轮次'));
    if (this.isClosing()) return stopped(this.block(failureOf('state_unavailable', '进程正在退出')));
    // 请求前重读持久状态：别的进程留下的 halted/running 不能被本实例的内存状态覆盖。
    this.sync();
    if (this.latch !== null) return stopped(this.latch);
    this.active = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const unmarked = this.persist({ kind: 'running' });
      if (unmarked !== null) return stopped(unmarked);
      let result;
      try {
        result = await this.execute(controller.signal);
      } catch (error) {
        return stopped(this.halt(failureOf('execution_failed', this.describeError(error))));
      }
      if (result.kind === 'halted') return stopped(this.halt(result.failure));
      // 停止发生在请求期间：execute 可能仍正常返回，但这一轮已被中止或已 latch，不能落回 idle。
      if (controller.signal.aborted || this.latch !== null) {
        return stopped(this.halt(this.latch ?? failureOf('stopped', '轮次在完成前被停止')));
      }
      // 结束态同样先写再放行：idle 落盘失败时本进程停止，持久状态停在 running，重开因此要求明确恢复。
      const unfinished = this.persist({ kind: 'idle' });
      if (unfinished !== null) return stopped(unfinished);
      return { kind: 'completed' };
    } finally {
      this.active = false;
      if (this.controller === controller) this.controller = null;
      if (!this.isClosing()) this.notify(this.state);
    }
  }

  /**
   * 同步停止：先 abort 在途请求，再上 latch，最后才尝试落盘。
   *
   * 顺序不能反——先落盘会在写等待期间继续发请求，而落盘失败也不改变本进程的停止决定。
   */
  stop(): AgentTurnFailure {
    this.stopRevision += 1;
    this.controller?.abort();
    const failure = failureOf('stopped', '宿主停止轮次');
    this.latch = failure;
    this.persist({ kind: 'halted', failure });
    return failure;
  }

  /**
   * 明确恢复：调用方核验通过才解除 latch。
   *
   * 核验负责重读历史、配置、租约与未决副作用；驱动只认它的结论，并在 idle 落盘成功之后才放行，
   * 避免核验通过但状态没写回去，让下一次打开重复要求恢复。
   */
  async retry(validate: () => boolean | Promise<boolean>): Promise<AgentTurnRetryOutcome> {
    if (this.active) return rejected(failureOf('recovery_rejected', '轮次仍在运行'));
    if (this.isClosing()) return rejected(this.block(failureOf('state_unavailable', '进程正在退出')));
    this.sync();
    const revision = this.stopRevision;
    let passed: boolean;
    try {
      passed = await validate();
    } catch (error) {
      return rejected(failureOf('recovery_rejected', this.describeError(error)));
    }
    if (!passed) return rejected(failureOf('recovery_rejected', '核验未通过'));
    if (this.isClosing() || this.active || revision !== this.stopRevision) {
      return rejected(failureOf('recovery_rejected', '核验期间轮次已停止或退出'));
    }
    const unfinished = this.persist({ kind: 'idle' });
    if (unfinished !== null) return rejected(unfinished);
    this.stopRevision += 1;
    this.latch = null;
    this.notify({ kind: 'idle' });
    return { kind: 'cleared' };
  }

  /** 重读持久状态并上 latch：durable 的 halted/running 都表示本进程没有可自动继续的轮次。 */
  private sync(): AgentTurnState {
    const durable = this.readDurable();
    if (durable.kind === 'halted') {
      this.latch = this.latch ?? durable.failure;
    } else if (durable.kind === 'running') {
      this.latch = this.latch ?? failureOf('interrupted', '上轮未结束，等待明确恢复');
    }
    return this.latch === null ? durable : { kind: 'halted', failure: this.latch };
  }

  private readDurable(): AgentTurnState {
    try {
      return this.turns.readTurnState(this.coordinatorSessionId);
    } catch (error) {
      return { kind: 'halted', failure: failureOf('state_unavailable', this.describeError(error)) };
    }
  }

  /** 只上 latch，不写存储。 */
  private block(failure: AgentTurnFailure): AgentTurnFailure {
    this.latch = failure;
    return failure;
  }

  /** 上 latch 并尝试落盘；返回 null 表示状态已写入或无需写，返回 failure 表示本进程因此停止。 */
  private persist(state: AgentTurnState): AgentTurnFailure | null {
    try {
      // 退出期间存储可能已关闭：跳过写入，本地 latch 仍然决定本进程不再发请求。
      if (this.isClosing()) return null;
      const written = this.turns.writeTurnState(this.coordinatorSessionId, state);
      if (written.kind === 'saved') {
        this.notify(state);
        return null;
      }
      return this.block(failureOf('state_unavailable', this.describeError(written.message)));
    } catch (error) {
      return this.block(failureOf('state_unavailable', this.describeError(error)));
    }
  }

  private halt(failure: AgentTurnFailure): AgentTurnFailure {
    const bounded: AgentTurnFailure = { code: failure.code, message: failure.message.slice(0, AGENT_TURN_MESSAGE_CHARS) };
    this.latch = bounded;
    this.persist({ kind: 'halted', failure: bounded });
    return bounded;
  }

  private notify(state: AgentTurnState): void {
    try { this.onStateChange(state); } catch { /* Observers cannot change a committed turn outcome. */ }
  }
}

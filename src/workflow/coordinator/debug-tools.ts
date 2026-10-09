/**
 * IP-03 / D-05：调试会话的只读工具集（Owner: 本 change 的 debug read tools）。
 *
 * 四个工具走的是与规划/执行工具**同一个** `CoordinatorToolDefinition` 协议，因此它们直接进受控
 * tools 节点：串行执行、逐 call 落盘、崩溃重放安全，不需要第二套执行协议。这里唯一新增的是
 * 闭合的名字与 schema——工具名是封闭联合，模型无法注册、覆盖或绕过它。
 *
 * 这里只做参数校验与结果归一化：真实读取由注入的 `DebugReadServices` 完成，workflow 不知道
 * 文件系统与 Git 的存在。装配（哪个根目录、什么预算）由 bootstrap 决定，因此换一套工具实现
 * 不需要改 workflow。
 *
 * 取消走 `CoordinatorToolCallContext.signal`：协调宿主当前不提供它，调试宿主提供，因此两者
 * 装配的是同一份工具定义。
 */

import type { DebugReadResult, DebugReadServices } from '../../application/ports/debug-read-tools.js';
import { asRecord, toolInputSchema } from './tool-definition.js';
import type { CoordinatorToolDefinition, CoordinatorToolOutcome } from './tool-definition.js';

export const DEBUG_TOOL_NAMES = ['list_files', 'read_file', 'search', 'git_diff'] as const;

export type DebugToolName = (typeof DEBUG_TOOL_NAMES)[number];

/** adapter 的 accepted / rejected 归一化成受控工具的三值；只读工具没有 unknown 这一支。 */
function toOutcome(result: DebugReadResult<unknown>): CoordinatorToolOutcome {
  return result.kind === 'accepted'
    ? { kind: 'ok', value: result.value }
    : result;
}

type ToolRejection = { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 输入边界。
 *
 * SDK 不保证一定按 inputSchema 校验模型给的参数，所以工具自己兜住两件事：输入不是对象时拒绝，
 * 以及出现未登记字段时拒绝而不是忽略——后者会让模型以为某个字段生效了，实际却被静默丢弃。
 */
function readArguments(
  input: unknown,
  allowed: readonly string[],
): { readonly fields: Record<string, unknown> } | ToolRejection {
  const fields = asRecord(input);
  if (fields === null) {
    return { kind: 'rejected', code: 'invalid_argument', message: '工具输入必须是对象' };
  }
  const unexpected = Object.keys(fields).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    return { kind: 'rejected', code: 'invalid_argument', message: `未登记字段：${unexpected}` };
  }
  return { fields };
}

function readString(fields: Record<string, unknown>, key: string): { readonly value: string } | ToolRejection {
  const raw = fields[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { kind: 'rejected', code: 'invalid_argument', message: `${key} 必须是非空字符串` };
  }
  return { value: raw };
}

function readOptionalString(fields: Record<string, unknown>, key: string): { readonly value?: string } | ToolRejection {
  const raw = fields[key];
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { kind: 'rejected', code: 'invalid_argument', message: `${key} 必须是非空字符串` };
  }
  return { value: raw };
}

const PATH_PROPERTY = { type: 'string', description: '相对调试根目录的路径' };

/**
 * 调试会话当前可见的只读工具集。顺序固定，因此同一份装配得到的工具列表是可复核的。
 *
 * 工具本身全部 `mutating: false`，因此 Coordinator 的 mutation 预算、fencing 与 unknown 对账
 * 对它们都不适用——它们只读，结果经正式工具配对回到模型与 transcript。
 */
export function createDebugTools(services: DebugReadServices): readonly CoordinatorToolDefinition[] {
  return [
    {
      name: 'list_files',
      description: '列出调试根目录内的文件与子目录（相对路径，目录以 / 结尾）。目录不可读时跳过该条目。',
      mutating: false,
      inputSchema: toolInputSchema({ path: PATH_PROPERTY }, []),
      invoke: async (input, context) => {
        const args = readArguments(input, ['path']);
        if ('kind' in args) {
          return args;
        }
        const path = readOptionalString(args.fields, 'path');
        if ('kind' in path) {
          return path;
        }
        return toOutcome(await services.listFiles(path.value === undefined ? {} : { path: path.value }, { signal: context.signal }));
      },
    },
    {
      name: 'read_file',
      description: '读取调试根目录内一个普通文件的内容，最多 64 KiB，超出部分被显式截断并标记。',
      mutating: false,
      inputSchema: toolInputSchema({ path: { type: 'string', description: '相对调试根目录的文件路径' } }, ['path']),
      invoke: async (input, context) => {
        const args = readArguments(input, ['path']);
        if ('kind' in args) {
          return args;
        }
        const path = readString(args.fields, 'path');
        if ('kind' in path) {
          return path;
        }
        return toOutcome(await services.readFile({ path: path.value }, { signal: context.signal }));
      },
    },
    {
      name: 'search',
      description: '在调试根目录内按固定字符串搜索，返回 `path:line: text` 命中行；不使用正则，扫描与命中都有上限。',
      mutating: false,
      inputSchema: toolInputSchema(
        {
          pattern: { type: 'string', description: '字面量子串，不是正则' },
          path: PATH_PROPERTY,
        },
        ['pattern'],
      ),
      invoke: async (input, context) => {
        const args = readArguments(input, ['pattern', 'path']);
        if ('kind' in args) {
          return args;
        }
        const pattern = readString(args.fields, 'pattern');
        if ('kind' in pattern) {
          return pattern;
        }
        const path = readOptionalString(args.fields, 'path');
        if ('kind' in path) {
          return path;
        }
        return toOutcome(
          await services.search(
            path.value === undefined ? { pattern: pattern.value } : { pattern: pattern.value, path: path.value },
            { signal: context.signal },
          ),
        );
      },
    },
    {
      name: 'git_diff',
      description: '返回调试根目录内的未提交差异（可选只看已暂存或限定路径）。目录不是 Git 仓库时结构化拒绝。',
      mutating: false,
      inputSchema: toolInputSchema(
        { path: PATH_PROPERTY, staged: { type: 'boolean', description: '只看已暂存的差异' } },
        [],
      ),
      invoke: async (input, context) => {
        const args = readArguments(input, ['path', 'staged']);
        if ('kind' in args) {
          return args;
        }
        const path = readOptionalString(args.fields, 'path');
        if ('kind' in path) {
          return path;
        }
        const staged = args.fields['staged'];
        if (staged !== undefined && typeof staged !== 'boolean') {
          return { kind: 'rejected', code: 'invalid_argument', message: 'staged 必须是布尔值' };
        }
        return toOutcome(
          await services.gitDiff(
            {
              ...(path.value === undefined ? {} : { path: path.value }),
              ...(staged === undefined ? {} : { staged }),
            },
            { signal: context.signal },
          ),
        );
      },
    },
  ];
}

export function isDebugToolName(raw: unknown): raw is DebugToolName {
  return typeof raw === 'string' && (DEBUG_TOOL_NAMES as readonly string[]).includes(raw);
}

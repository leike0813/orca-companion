/**
 * 用户级 CredentialStore 的同步窄端口（Owner: `complete-tui-model-configuration` IP-02 / D02）。
 *
 * 这是项目里唯一保存明文 API key 的地方：项目配置、UI input store、checkpoint、命令参数与证据
 * 一律只保存 `credentialRef`。引用一旦生成就不可变，也不表达任何含义，因此这里返回的
 * `refs` 只是身份集合，不含 secret；secret 只在 `read` 的返回值里出现。
 *
 * 调用约定：
 * - 三个方法同步返回结果联合而不抛异常，文件系统的任何失败都是带结构化 code 的 `rejected`；
 * - `save` 携带调用方读到的 `expectedRevision`，并发写者不会互相覆盖，冲突也保留调用方输入；
 * - 错误文案固定且安全，不转发包含载荷或原始异常的字符串，因此调用方不需要再脱敏；
 * - 不存在「读取当前 secret 再写回」的路径：保存总是追加新引用，旧引用保持可读。
 */

/** 失败结果：只有结构化 code 和安全文案，secret 永远不会出现在这里。 */
export type CredentialFailure = {
  readonly kind: 'rejected';
  readonly code: string;
  readonly message: string;
};

/** store 现状：只有 revision 与不可变引用集合；不泄露 secret 长度以外的任何内容。 */
export type CredentialMetadataResult =
  | {
      readonly kind: 'metadata';
      readonly revision: number;
      readonly refs: readonly string[];
    }
  | CredentialFailure;

export type CredentialReadResult =
  | { readonly kind: 'resolved'; readonly secret: string }
  | CredentialFailure;

export type CredentialSaveInput = {
  /** 调用方最近一次 `metadata()` 读到的 revision；`0` 表示期望 store 还不存在。 */
  readonly expectedRevision: number;
  readonly secret: string;
};

export type CredentialSaveResult =
  | {
      readonly kind: 'saved';
      readonly revision: number;
      /** 新生成的不可变引用；调用方随后才能把引用写进项目配置。 */
      readonly credentialRef: string;
    }
  | CredentialFailure;

export interface CredentialStore {
  metadata(): CredentialMetadataResult;
  read(credentialRef: string): CredentialReadResult;
  save(input: CredentialSaveInput): CredentialSaveResult;
}

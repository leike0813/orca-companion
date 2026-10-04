import process from 'node:process';
import { createTuiPreferencesStore } from '../../dist/src/adapters/storage/tui-preferences-store.js';
import { readProjectDetailPage } from '../../dist/src/application/tui/project-details.js';

// Deliberately labelled fixtures; this module never connects to tracker/model/Orca.
export async function createPreviewPorts(snapshot) {
  const configHome = process.env.ORCA_COMPANION_PREVIEW_CONFIG_HOME;
  if (!configHome) throw new Error('Batch-seven preview requires an explicit isolated configHome');
  const store = createTuiPreferencesStore({ configHome });
  const presentation = (current, selectedSessionId) => {
    const id = selectedSessionId ?? current.sessions[0]?.coordinatorSessionId;
    const executing = current.mode === 'execution_coordination';
    const active = current.frontier.find(entry => entry.role !== null && entry.attemptId !== null);
    return {
      identity: { repository: '示例仓库', fullBranchRef: 'refs/heads/main' },
      session: id ? { id, model: id === 'session-b' ? '示例模型 B' : '示例模型 A', provider: '示例 provider',
        effort: id === 'session-b' ? { status: 'not_configured' } : { status: 'configured', value: 'high' } } : null,
      ticket: !executing && current.graph ? { ref: '#48', title: '状态栏展示与偏好（隔离示例）' } : null,
      activeWorkPackage: active ? { id: active.workPackageId, title: current.graphTopologies[0]?.nodes.find(node => node.workPackageId === active.workPackageId)?.title ?? active.workPackageId } : null,
      context: current.controlState === 'blocked' || id === 'session-b' ? { status: 'unavailable' }
        : { status: 'available', used: 62000, capacity: 100000, observationId: 'fixture-exact-context',
          coordinatorSessionId: id, modelConfigurationRef: 'config-a', effectiveInputRevision: 1 },
      // Explicit application summary fixture, intentionally different from node lifecycle counts.
      acceptance: current.graph ? { graphId: current.graph.graphId, generation: current.graph.generation,
        version: current.graph.graphVersion, validatedCount: executing ? 7 : 0, totalCount: current.graphTopologies[0]?.nodes.length ?? 0 } : null,
      budgets: {
        workPackages: executing ? { status: 'available', consumed: current.graphTopologies[0]?.nodes.length ?? 0,
          limit: 24, subject: current.graph.graphId, approvedLimitRef: 'fixture-approved-authorization' } : null,
        implementationAttempts: active ? { status: 'available', consumed: 1, limit: 2,
          subject: active.workPackageId, approvedLimitRef: 'fixture-approved-authorization' } : null,
        recovery: active ? { status: 'available', consumed: 0, limit: 2,
          subject: active.attemptId, approvedLimitRef: 'fixture-original-attempt-authorization' } : null,
      },
    };
  };
  return { presentation, ports: {
    preferences: {
      load: () => store.load(),
      save: input => process.env.ORCA_COMPANION_PREVIEW_SAVE_FAIL === '1'
        ? Promise.resolve({ kind: 'failed', code: 'fixture_write_failed', message: '隔离示例：偏好保存失败，草稿保留' })
        : store.save(input),
    },
    projectDetails: { read: async query => {
      if (query.seenRevision !== snapshot.revision) return { kind: 'stale', currentRevision: snapshot.revision };
      const fields = query.objectKey === 'identity'
        ? [{ label: '仓库', value: '示例仓库' }, { label: '完整分支', value: 'refs/heads/main' },
          { label: 'Scope', value: snapshot.coordinationScopeId }, { label: 'Session', value: query.coordinatorSessionId },
          { label: 'Claim', value: snapshot.mode === 'route_planning' ? '#48 · 状态栏展示（隔离示例）' : '未领取' }]
        : query.objectKey === 'budget'
          ? [{ label: '工作包数量', value: '20 / 24 · graph-prototype（隔离示例）' },
            { label: '实现尝试', value: '1 / 2 · wp-12（隔离示例）' }, { label: '恢复', value: '0 / 2 · attempt-12（隔离示例）' },
            { label: '批准引用', value: snapshot.authorization?.authorizationId ?? '未授权' }]
          : [{ label: '已批准授权', value: snapshot.authorization?.authorizationId ?? '未授权' },
            { label: '版本', value: String(snapshot.authorization?.version ?? '不可用') },
            { label: '允许操作', value: '仅隔离工作区；无发布、部署或历史改写（隔离示例）' },
            ...Array.from({length:25},(_,index)=>({label:`批准字段 ${index+1}`,value:`隔离示例授权内容 ${index+1}`})),
            {label:'长授权字段',value:'中文🙂授权说明。'.repeat(9000)}];
      return readProjectDetailPage({query,revision:snapshot.revision,
        fields:()=>fields.map((field,index)=>({...field,key:String(index)}))});
    } },
  } };
}

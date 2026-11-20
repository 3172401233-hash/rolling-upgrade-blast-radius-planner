import { planUpgrade, assessHealth } from '../index.js';

// 一个贴近真实场景的例子：共享数据库、依赖环、错误预算与维护窗口。
const input = {
  services: [
    { name: 'mysql', kind: 'database', version: '8.0.0', targetVersion: '8.1.0', replicas: 3, minHealthyRatio: 0.67, waveMinutes: 15, stabilizeMinutes: 10, rollbackMinutes: 30, allowCoexistence: true, maxCoexistenceMinutes: 120 },
    { name: 'api', version: '4.2.0', targetVersion: '5.0.0', replicas: 8, minHealthyRatio: 0.75, waveMinutes: 6, stabilizeMinutes: 10, rollbackMinutes: 12 },
    { name: 'worker', version: '4.2.0', targetVersion: '5.0.0', replicas: 4, minHealthyRatio: 0.5, waveMinutes: 6, stabilizeMinutes: 5, rollbackMinutes: 12 },
    { name: 'gateway', version: '2.1.0', targetVersion: '2.2.0', replicas: 4, minHealthyRatio: 0.75, waveMinutes: 4, stabilizeMinutes: 5, rollbackMinutes: 8 },
    { name: 'auth', version: '1.9.0', targetVersion: '2.0.0', replicas: 4, minHealthyRatio: 0.75, waveMinutes: 5, stabilizeMinutes: 5, rollbackMinutes: 10 },
    { name: 'session', version: '1.9.0', targetVersion: '2.0.0', replicas: 2, minHealthyRatio: 0.5, waveMinutes: 5, stabilizeMinutes: 5, rollbackMinutes: 10 },
  ],
  dependencies: [
    { from: 'api', to: 'mysql' },
    { from: 'worker', to: 'mysql' },
    { from: 'gateway', to: 'api' },
    { from: 'gateway', to: 'auth' },
    { from: 'api', to: 'auth' },
    { from: 'auth', to: 'session' },
    { from: 'session', to: 'auth' }, // auth <-> session 成环
  ],
  compatibility: {
    api: { '5.0.0': { mysql: ['>=8.1.0'], auth: ['2.x'] } },
    worker: { '5.0.0': { mysql: ['>=8.1.0'] } },
    gateway: { '2.2.0': { api: ['4.2.0', '5.0.0'], auth: ['1.9.0', '2.0.0'] } },
    auth: { '2.0.0': { session: ['2.0.0'] } },
    session: { '2.0.0': { auth: ['2.0.0'] } },
  },
  errorBudgetMinutes: 60,
  maintenanceWindowMinutes: 180,
};

const plan = planUpgrade(input);

console.log('=== 滚动升级计划 ===');
console.log(`可行: ${plan.feasible}`);
console.log(`维护窗口: 需要 ${plan.maintenanceWindow.requiredMinutes} / ${plan.maintenanceWindow.totalMinutes} 分钟 (fits=${plan.maintenanceWindow.fits})`);
console.log(`错误预算: 消耗 ${plan.errorBudget.consumedMinutes} / ${plan.errorBudget.totalMinutes} 容量·分钟`);
console.log('');
for (const batch of plan.batches) {
  console.log(`批次 ${batch.index}: [${batch.services.join(', ')}]`);
  console.log(`  时长 ${batch.durationMinutes} 分钟 (升级 ${batch.upgradeMinutes} + 稳定观察 ${batch.stabilizeMinutes})`);
  console.log(`  预估降级 ${batch.unavailableMinutes} 容量·分钟, 累计 ${batch.cumulativeElapsedMinutes} 分钟, 回滚成本 ${batch.rollbackMinutes} 分钟`);
  if (batch.forcedGroups.length > 0) console.log(`  强制并行组: ${JSON.stringify(batch.forcedGroups)}`);
  for (const note of batch.notes) console.log(`  备注: ${note}`);
}
if (plan.mustRunTogether.length > 0) {
  console.log('');
  console.log('必须并行的服务:');
  for (const group of plan.mustRunTogether) {
    console.log(`  [${group.services.join(', ')}] <- ${group.reason}`);
  }
}
if (plan.blocked.length > 0) {
  console.log('');
  console.log('被阻塞的服务:');
  for (const item of plan.blocked) {
    console.log(`  ${item.service}: ${item.reasons.join('; ')}`);
  }
}

console.log('');
console.log('=== 健康度决策示例 ===');
for (const ratio of [0.9, 0.6, 0.2]) {
  console.log(`api 健康度 ${ratio}:`, JSON.stringify(assessHealth(
    { name: 'api', version: '4.2.0', minHealthyRatio: 0.75, rollbackMinutes: 12 },
    ratio,
  )));
}

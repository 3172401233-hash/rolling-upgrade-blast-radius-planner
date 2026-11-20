import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planUpgrade, assessHealth, computeInstancePlan } from '../index.js';

function svc(overrides) {
  return {
    replicas: 2,
    minHealthyRatio: 0.5,
    waveMinutes: 5,
    stabilizeMinutes: 5,
    rollbackMinutes: 8,
    ...overrides,
  };
}

test('线性依赖：按 db -> api -> web 顺序逐批升级', () => {
  const plan = planUpgrade({
    services: [
      svc({ name: 'db', version: '1.0.0', targetVersion: '2.0.0', kind: 'database' }),
      svc({ name: 'api', version: '1.0.0', targetVersion: '2.0.0' }),
      svc({ name: 'web', version: '1.0.0', targetVersion: '2.0.0' }),
    ],
    dependencies: [
      { from: 'api', to: 'db' },
      { from: 'web', to: 'api' },
    ],
    compatibility: {
      api: { '2.0.0': { db: ['2.x'] } },
      web: { '2.0.0': { api: ['2.x'] } },
    },
    errorBudgetMinutes: 100,
    maintenanceWindowMinutes: 240,
  });

  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.batches.map((b) => b.services), [['db'], ['api'], ['web']]);
  assert.equal(plan.maintenanceWindow.fits, true);
  assert.equal(plan.errorBudget.exhausted, false);
});

test('多服务并行：无依赖的服务合并进同一批次', () => {
  const plan = planUpgrade({
    services: [
      svc({ name: 'a', version: '1.0.0', targetVersion: '2.0.0' }),
      svc({ name: 'b', version: '1.0.0', targetVersion: '2.0.0' }),
      svc({ name: 'c', version: '1.0.0', targetVersion: '2.0.0' }),
    ],
    errorBudgetMinutes: 100,
  });

  assert.equal(plan.feasible, true);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].services, ['a', 'b', 'c']);
});

test('不兼容版本：目标版本与固定下游不兼容时被阻塞并给出原因', () => {
  const plan = planUpgrade({
    services: [
      svc({ name: 'api', version: '1.0.0', targetVersion: '2.0.0' }),
      svc({ name: 'db', version: '1.0.0' }), // db 不在本次升级范围
    ],
    dependencies: [{ from: 'api', to: 'db' }],
    compatibility: {
      api: { '2.0.0': { db: ['>=2.0.0'] } },
    },
  });

  assert.equal(plan.feasible, false);
  assert.equal(plan.batches.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].service, 'api');
  assert.match(plan.blocked[0].reasons.join(' '), /db@1\.0\.0/);
});

test('错误预算耗尽：预算只够第一批，其余服务被阻塞', () => {
  // 每个服务：replicas=2, minHealthy=0.5 -> 每波 1 实例，2 波 * 10 分钟 = 20 分钟
  // 降级成本 = 20 * (1/2) = 10 容量·分钟；预算 12 只够一个服务。
  const plan = planUpgrade({
    services: [
      svc({ name: 'a', version: '1.0.0', targetVersion: '2.0.0', waveMinutes: 10 }),
      svc({ name: 'b', version: '1.0.0', targetVersion: '2.0.0', waveMinutes: 10 }),
    ],
    errorBudgetMinutes: 12,
  });

  assert.equal(plan.feasible, false);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].services, ['a']);
  assert.equal(plan.errorBudget.exhausted, true);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].service, 'b');
  assert.match(plan.blocked[0].reasons.join(' '), /错误预算不足/);
});

test('环路：依赖成环的服务必须同批升级', () => {
  const plan = planUpgrade({
    services: [
      svc({ name: 'a', version: '1.0.0', targetVersion: '2.0.0' }),
      svc({ name: 'b', version: '1.0.0', targetVersion: '2.0.0' }),
    ],
    dependencies: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
    errorBudgetMinutes: 100,
  });

  assert.equal(plan.feasible, true);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].services, ['a', 'b']);
  assert.deepEqual(plan.batches[0].forcedGroups, [['a', 'b']]);
  assert.equal(plan.mustRunTogether.length, 1);
  assert.match(plan.mustRunTogether[0].reason, /dependency-cycle/);
});

test('互相版本约束：非环但互为前置条件的服务被合并为同批', () => {
  const plan = planUpgrade({
    services: [
      svc({ name: 'a', version: '1.0.0', targetVersion: '2.0.0' }),
      svc({ name: 'b', version: '1.0.0', targetVersion: '2.0.0' }),
    ],
    dependencies: [{ from: 'a', to: 'b' }],
    compatibility: {
      // a@2 只能配 b@2；b@2 又拒绝 a@1 —— 单方面先升谁都不可行。
      a: { '2.0.0': { b: ['2.0.0'] } },
      b: { '2.0.0': { a: ['2.0.0'] } },
    },
    errorBudgetMinutes: 100,
  });

  assert.equal(plan.feasible, true);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].services, ['a', 'b']);
  assert.equal(plan.mustRunTogether.length, 1);
  assert.match(plan.mustRunTogether[0].reason, /mutual-version-constraint/);
});

test('回滚与暂停：健康度恶化时给出 pause / rollback 决策', () => {
  const service = svc({ name: 'api', version: '1.0.0', targetVersion: '2.0.0', minHealthyRatio: 0.75 });

  const healthy = assessHealth(service, 0.9);
  assert.equal(healthy.action, 'proceed');

  const degraded = assessHealth(service, 0.6);
  assert.equal(degraded.action, 'pause');
  assert.match(degraded.reason, /暂停/);

  const critical = assessHealth(service, 0.2);
  assert.equal(critical.action, 'rollback');
  assert.equal(critical.estimatedRollbackMinutes, service.rollbackMinutes);
});

test('数据库不允许版本并存：单波整体切换且期间完全不可用', () => {
  const db = svc({
    name: 'db',
    version: '1.0.0',
    targetVersion: '2.0.0',
    kind: 'database',
    allowCoexistence: false,
    replicas: 4,
    waveMinutes: 8,
  });
  const instancePlan = computeInstancePlan(db);
  assert.equal(instancePlan.waves, 1);
  assert.equal(instancePlan.waveSize, 4);
  assert.equal(instancePlan.degradedMinutes, 8);

  const plan = planUpgrade({ services: [db], errorBudgetMinutes: 100 });
  assert.equal(plan.feasible, true);
  assert.equal(plan.batches[0].unavailableMinutes, 8);
  assert.match(plan.batches[0].notes.join(' '), /完全不可用/);
});

test('维护窗口：累计时长超窗时标记 fits=false 并定位超限批次', () => {
  const plan = planUpgrade({
    services: [
      svc({ name: 'db', version: '1.0.0', targetVersion: '2.0.0', waveMinutes: 5, stabilizeMinutes: 10 }),
      svc({ name: 'api', version: '1.0.0', targetVersion: '2.0.0', waveMinutes: 5, stabilizeMinutes: 10 }),
    ],
    dependencies: [{ from: 'api', to: 'db' }],
    compatibility: { api: { '2.0.0': { db: ['2.x'] } } },
    errorBudgetMinutes: 100,
    maintenanceWindowMinutes: 25,
  });

  assert.equal(plan.feasible, true);
  assert.equal(plan.batches.length, 2);
  assert.equal(plan.maintenanceWindow.fits, false);
  assert.equal(plan.batches[0].exceedsWindow, false);
  assert.equal(plan.batches[1].exceedsWindow, true);
});

test('多版本并存窗口：分批耗时超过并存窗口的服务被阻塞', () => {
  const plan = planUpgrade({
    services: [
      svc({
        name: 'legacy',
        version: '1.0.0',
        targetVersion: '2.0.0',
        replicas: 4,
        minHealthyRatio: 0.75, // 每波只能下线 1 个实例 -> 4 波
        waveMinutes: 30, // 共 120 分钟
        maxCoexistenceMinutes: 60,
      }),
    ],
    errorBudgetMinutes: 1000,
  });

  assert.equal(plan.feasible, false);
  assert.match(plan.blocked[0].reasons.join(' '), /多版本并存窗口/);
});

test('共享下游：批次备注中标注共享下游及其调用方数量', () => {
  const plan = planUpgrade({
    services: [
      svc({ name: 'db', version: '1.0.0', targetVersion: '2.0.0' }),
      svc({ name: 'api', version: '1.0.0', targetVersion: '2.0.0' }),
      svc({ name: 'worker', version: '1.0.0', targetVersion: '2.0.0' }),
    ],
    dependencies: [
      { from: 'api', to: 'db' },
      { from: 'worker', to: 'db' },
    ],
    compatibility: {
      api: { '2.0.0': { db: ['2.x'] } },
      worker: { '2.0.0': { db: ['2.x'] } },
    },
    errorBudgetMinutes: 100,
  });

  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.batches[0].services, ['db']);
  assert.match(plan.batches[0].notes.join(' '), /共享下游/);
});

import { matchesAnyPattern } from './version-match.js';
import { stronglyConnectedComponents } from './graph.js';

const EPSILON = 1e-9;

const SERVICE_DEFAULTS = {
  replicas: 1,
  minHealthyRatio: 0.5,
  waveMinutes: 5,
  stabilizeMinutes: 5,
  rollbackMinutes: 10,
  kind: 'service',
  allowCoexistence: true,
  maxCoexistenceMinutes: Infinity,
};

function round3(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1000) / 1000;
}

export function normalizeService(raw) {
  if (!raw || typeof raw.name !== 'string' || raw.name === '') {
    throw new Error('每个服务必须包含非空的 name');
  }
  if (typeof raw.version !== 'string' || raw.version === '') {
    throw new Error(`服务 ${raw.name} 缺少当前版本 version`);
  }
  const minHealthyRatio = raw.minHealthyRatio ?? SERVICE_DEFAULTS.minHealthyRatio;
  const service = {
    ...SERVICE_DEFAULTS,
    ...raw,
    targetVersion: raw.targetVersion ?? null,
    minHealthyRatio,
    criticalHealthyRatio: raw.criticalHealthyRatio ?? minHealthyRatio / 2,
  };
  if (service.replicas < 1) throw new Error(`服务 ${service.name} 的 replicas 必须 >= 1`);
  if (service.minHealthyRatio <= 0 || service.minHealthyRatio > 1) {
    throw new Error(`服务 ${service.name} 的 minHealthyRatio 必须在 (0, 1] 区间`);
  }
  return service;
}

/**
 * 计算单个服务的实例分批方案。
 * 健康阈值要求任意时刻健康副本数 >= ceil(replicas * minHealthyRatio)，
 * 因此每波最多同时下线 replicas - minHealthy 个实例。
 * allowCoexistence = false（常见于数据库）时禁止新旧版本并存，
 * 只能单波整体切换，期间服务完全不可用。
 */
export function computeInstancePlan(service) {
  const minHealthy = Math.ceil(service.replicas * service.minHealthyRatio);
  const waveSize = service.allowCoexistence
    ? Math.max(1, service.replicas - minHealthy)
    : service.replicas;
  const waves = Math.ceil(service.replicas / waveSize);
  const durationMinutes = waves * service.waveMinutes;
  const degradedMinutes = service.allowCoexistence
    ? durationMinutes * (waveSize / service.replicas)
    : durationMinutes;
  return { waveSize, waves, durationMinutes, degradedMinutes };
}

/**
 * 根据观测到的健康度决定继续、暂停还是回滚。
 * observedHealthyRatio 为当前健康副本占比（0..1）。
 */
export function assessHealth(serviceLike, observedHealthyRatio) {
  const service = normalizeService(serviceLike);
  if (observedHealthyRatio >= service.minHealthyRatio) {
    return { action: 'proceed', service: service.name, reason: '健康度满足阈值，可继续下一批次' };
  }
  if (observedHealthyRatio >= service.criticalHealthyRatio) {
    return {
      action: 'pause',
      service: service.name,
      reason: `健康度 ${observedHealthyRatio} 低于阈值 ${service.minHealthyRatio}，暂停后续批次并观察`,
      resumeWhen: `健康度恢复到 >= ${service.minHealthyRatio}`,
    };
  }
  return {
    action: 'rollback',
    service: service.name,
    reason: `健康度 ${observedHealthyRatio} 跌破临界值 ${service.criticalHealthyRatio}，立即回滚`,
    estimatedRollbackMinutes: service.rollbackMinutes,
  };
}

/**
 * 规划滚动升级批次。
 *
 * @param {object} input
 * @param {Array} input.services        服务清单（含当前/目标版本、副本数、健康阈值等）
 * @param {Array} input.dependencies    依赖边 [{ from: 'api', to: 'db' }] 表示 api 调用 db
 * @param {object} input.compatibility  兼容矩阵 compatibility[svc][version][dep] = [可通信版本...]
 * @param {number} input.errorBudgetMinutes    错误预算（可接受的累计降级容量·分钟）
 * @param {number} input.maintenanceWindowMinutes 维护窗口（分钟）
 */
export function planUpgrade(input) {
  if (!input || !Array.isArray(input.services) || input.services.length === 0) {
    throw new Error('input.services 必须是非空数组');
  }
  const services = new Map();
  for (const raw of input.services) {
    const service = normalizeService(raw);
    if (services.has(service.name)) throw new Error(`服务 ${service.name} 重复定义`);
    services.set(service.name, service);
  }

  const outgoing = new Map();
  const incoming = new Map();
  for (const name of services.keys()) {
    outgoing.set(name, new Set());
    incoming.set(name, new Set());
  }
  for (const edge of input.dependencies ?? []) {
    if (!services.has(edge.from)) throw new Error(`依赖边的 from 服务不存在: ${edge.from}`);
    if (!services.has(edge.to)) throw new Error(`依赖边的 to 服务不存在: ${edge.to}`);
    outgoing.get(edge.from).add(edge.to);
    incoming.get(edge.to).add(edge.from);
  }

  const compatibility = input.compatibility ?? {};
  const errorBudgetTotal = input.errorBudgetMinutes ?? Infinity;
  const windowMinutes = input.maintenanceWindowMinutes ?? Infinity;

  const edges = (input.dependencies ?? []).map(({ from, to }) => ({ from, to }));

  // svc 在 sv 版本下能否与 dep 的 dv 版本通信；矩阵中未列出的组合默认兼容。
  function isCompatible(svc, sv, dep, dv) {
    const entry = compatibility?.[svc]?.[sv]?.[dep];
    if (entry === undefined) return true;
    return matchesAnyPattern(dv, entry);
  }

  const instancePlans = new Map();
  for (const [name, service] of services) {
    instancePlans.set(name, computeInstancePlan(service));
  }

  const currentVersion = new Map();
  const remaining = new Set();
  for (const [name, service] of services) {
    currentVersion.set(name, service.version);
    if (service.targetVersion && service.targetVersion !== service.version) {
      remaining.add(name);
    }
  }

  // ---- 强制并行分组：依赖环（SCC）+ 互相版本约束导致的死锁对 ----
  const parent = new Map();
  for (const name of remaining) parent.set(name, name);
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const mustRunTogether = [];
  const remainingAdjacency = new Map();
  for (const name of remaining) {
    remainingAdjacency.set(name, new Set([...outgoing.get(name)].filter((n) => remaining.has(n))));
  }
  for (const component of stronglyConnectedComponents([...remaining], remainingAdjacency)) {
    if (component.length > 1) {
      for (let i = 1; i < component.length; i += 1) union(component[0], component[i]);
      mustRunTogether.push({ services: component, reason: 'dependency-cycle: 依赖成环，无法确定先后，必须同批升级' });
    }
  }

  function groupUnits() {
    const units = new Map();
    for (const name of remaining) {
      const root = find(name);
      if (!units.has(root)) units.set(root, []);
      units.get(root).push(name);
    }
    return [...units.values()].map((names) => names.sort());
  }

  /**
   * 校验一组升级单元在当前版本状态下是否保持全链路兼容。
   * units 中同一单元（依赖环或互相前置的强制并行组）内部按同步切换处理，
   * 只校验 旧-旧 / 新-新 组合；跨单元与跨批次边界则校验所有并存组合。
   * 兼容矩阵双向生效：调用方与被调方任一侧声明不兼容即视为不兼容。
   */
  function checkPlan(units) {
    const unitOf = new Map();
    units.forEach((unit, index) => {
      for (const name of unit) unitOf.set(name, index);
    });
    const reasons = new Set();

    for (const unit of units) {
      for (const name of unit) {
        const service = services.get(name);
        const plan = instancePlans.get(name);
        if (plan.durationMinutes > service.maxCoexistenceMinutes) {
          reasons.add(
            `${name}: 实例分批升级需 ${plan.durationMinutes} 分钟，超出多版本并存窗口 ${service.maxCoexistenceMinutes} 分钟`,
          );
        }
      }
    }

    for (const { from, to } of edges) {
      if (from === to) continue;
      const fromUnit = unitOf.get(from);
      const toUnit = unitOf.get(to);
      if (fromUnit === undefined && toUnit === undefined) continue;
      const fromVersions = fromUnit === undefined
        ? [currentVersion.get(from)]
        : [currentVersion.get(from), services.get(from).targetVersion];
      const toVersions = toUnit === undefined
        ? [currentVersion.get(to)]
        : [currentVersion.get(to), services.get(to).targetVersion];
      const sameUnit = fromUnit !== undefined && fromUnit === toUnit;

      for (const fv of fromVersions) {
        for (const tv of toVersions) {
          if (sameUnit) {
            const fromIsNew = fv === services.get(from).targetVersion;
            const toIsNew = tv === services.get(to).targetVersion;
            if (fromIsNew !== toIsNew) continue;
          }
          if (!isCompatible(from, fv, to, tv)) {
            reasons.add(`${from}@${fv} 无法调用 ${to}@${tv}`);
          }
          if (!isCompatible(to, tv, from, fv)) {
            reasons.add(`${to}@${tv} 不接受来自 ${from}@${fv} 的调用`);
          }
        }
      }
    }
    return { ok: reasons.size === 0, reasons: [...reasons] };
  }

  const batches = [];
  const blocked = new Map();
  let budgetLeft = errorBudgetTotal;
  let elapsed = 0;
  let budgetExhausted = false;

  while (remaining.size > 0) {
    const units = groupUnits();
    const upgradeable = [];
    const failReasons = new Map();
    for (const unit of units) {
      const result = checkPlan([unit]);
      if (result.ok) {
        const cost = unit.reduce((sum, n) => sum + instancePlans.get(n).degradedMinutes, 0);
        upgradeable.push({ names: unit, cost });
      } else {
        failReasons.set(unit.join(','), result.reasons);
      }
    }

    if (upgradeable.length === 0) {
      // 尝试合并互相死锁的单元：单独升级都会破坏兼容，但同批升级可行。
      let merged = false;
      for (let i = 0; i < units.length && !merged; i += 1) {
        for (let j = i + 1; j < units.length && !merged; j += 1) {
          const combined = [...units[i], ...units[j]].sort();
          if (checkPlan([combined]).ok) {
            union(units[i][0], units[j][0]);
            mustRunTogether.push({
              services: combined,
              reason: 'mutual-version-constraint: 互为新旧版本前置条件，必须同批升级',
            });
            merged = true;
          }
        }
      }
      if (merged) continue;
      for (const unit of units) {
        const reasons = failReasons.get(unit.join(',')) ?? ['无法确定安全升级顺序'];
        for (const name of unit) blocked.set(name, reasons);
      }
      break;
    }

    // 在错误预算内尽量并行：逐个加入候选单元，并做整批联合兼容校验。
    upgradeable.sort((a, b) => a.names.join(',').localeCompare(b.names.join(',')));
    const chosen = [];
    const chosenNames = new Set();
    let batchCost = 0;
    for (const unit of upgradeable) {
      if (batchCost + unit.cost > budgetLeft + EPSILON) continue;
      const trial = [...chosen.map((u) => u.names), unit.names];
      if (!checkPlan(trial).ok) continue;
      chosen.push(unit);
      for (const n of unit.names) chosenNames.add(n);
      batchCost += unit.cost;
    }

    if (chosen.length === 0) {
      const cheapest = Math.min(...upgradeable.map((u) => u.cost));
      const reason = cheapest > budgetLeft + EPSILON
        ? `错误预算不足：剩余 ${round3(budgetLeft)} 分钟，最小升级成本 ${round3(cheapest)} 分钟`
        : '候选批次之间存在相互不兼容，无法同批调度';
      if (cheapest > budgetLeft + EPSILON) budgetExhausted = true;
      for (const name of remaining) blocked.set(name, [reason]);
      break;
    }

    const batchServices = [...chosenNames].sort();
    const upgradeMinutes = Math.max(...batchServices.map((n) => instancePlans.get(n).durationMinutes));
    const stabilizeMinutes = Math.max(...batchServices.map((n) => services.get(n).stabilizeMinutes));
    const rollbackMinutes = Math.max(...batchServices.map((n) => services.get(n).rollbackMinutes));
    elapsed += upgradeMinutes + stabilizeMinutes;
    budgetLeft -= batchCost;

    const notes = [];
    for (const name of batchServices) {
      const service = services.get(name);
      if (!service.allowCoexistence) {
        notes.push(`${name} 不允许新旧版本并存（${service.kind}），升级期间完全不可用`);
      }
      if (incoming.get(name).size > 1) {
        notes.push(`${name} 是 ${incoming.get(name).size} 个服务的共享下游，需同时保持对所有调用方兼容`);
      }
    }
    const forcedGroups = groupUnitsBeforeApply(chosen);

    batches.push({
      index: batches.length,
      services: batchServices,
      forcedGroups,
      upgradeMinutes: round3(upgradeMinutes),
      stabilizeMinutes: round3(stabilizeMinutes),
      durationMinutes: round3(upgradeMinutes + stabilizeMinutes),
      unavailableMinutes: round3(batchCost),
      cumulativeElapsedMinutes: round3(elapsed),
      exceedsWindow: elapsed > windowMinutes + EPSILON,
      rollbackMinutes: round3(rollbackMinutes),
      notes,
    });

    for (const name of batchServices) {
      currentVersion.set(name, services.get(name).targetVersion);
      remaining.delete(name);
    }
  }

  function groupUnitsBeforeApply(chosen) {
    const groups = [];
    for (const unit of chosen) {
      if (unit.names.length > 1) groups.push([...unit.names].sort());
    }
    return groups;
  }

  const blockedList = [...blocked.entries()]
    .map(([service, reasons]) => ({ service, reasons }))
    .sort((a, b) => a.service.localeCompare(b.service));
  const consumed = errorBudgetTotal === Infinity ? null : round3(errorBudgetTotal - budgetLeft);

  return {
    feasible: blockedList.length === 0,
    batches,
    mustRunTogether,
    blocked: blockedList,
    errorBudget: {
      totalMinutes: errorBudgetTotal,
      consumedMinutes: consumed,
      remainingMinutes: round3(budgetLeft),
      exhausted: budgetExhausted,
    },
    maintenanceWindow: {
      totalMinutes: windowMinutes,
      requiredMinutes: round3(elapsed),
      fits: elapsed <= windowMinutes + EPSILON,
    },
    summary: {
      totalServices: services.size,
      upgradedServices: services.size - remaining.size,
      blockedServices: blockedList.length,
      batchCount: batches.length,
    },
  };
}

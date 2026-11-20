# rolling-upgrade-blast-radius-planner

规划多服务滚动升级顺序并限制故障影响范围。

> **重要说明：本工具只产出升级计划（批次、顺序、预估影响），不直接操作任何发布系统。**
> 计划的执行、暂停与回滚需由运维人员或发布平台根据输出决策自行完成。

运行环境：Node.js >= 24.16.0，零第三方依赖。

## 能力

- 按依赖图与兼容矩阵推导安全升级批次，每批完成并稳定后才进入下一批
- 无依赖关系的服务自动并行到同一批次；依赖成环或互为版本前置的服务强制同批（同步切换）
- 实例级分批：根据副本数与健康阈值计算每波可下线实例数与波次耗时
- 多版本并存窗口：分批耗时超过 `maxCoexistenceMinutes` 的服务会被阻塞并说明原因
- 数据库限制：`allowCoexistence: false` 时单波整体切换，期间按完全不可用计入错误预算
- 共享下游：兼容校验双向生效，批次备注中标注共享下游及其调用方数量
- 错误预算：以"降级容量·分钟"计量，预算不足时停止排程并阻塞剩余服务
- 维护窗口：累计批次时长超窗时标记 `fits=false` 并定位超限批次
- 健康决策：`assessHealth()` 根据观测健康度返回 `proceed` / `pause` / `rollback`

## 输入

```js
planUpgrade({
  services: [{
    name: 'api',
    version: '4.2.0',            // 当前版本（必填）
    targetVersion: '5.0.0',      // 目标版本；缺省或等于当前版本表示本次不升级
    kind: 'service',             // 'service' | 'database'
    replicas: 8,                 // 副本数
    minHealthyRatio: 0.75,       // 升级期间必须保持的健康副本比例
    criticalHealthyRatio: 0.375, // 跌破则直接回滚（默认 minHealthyRatio / 2）
    waveMinutes: 6,              // 单波实例升级 + 健康检查耗时
    stabilizeMinutes: 10,        // 批次完成后的稳定观察时间
    rollbackMinutes: 12,         // 该服务整体回滚耗时
    allowCoexistence: true,      // 是否允许新旧版本并存
    maxCoexistenceMinutes: 120,  // 多版本并存窗口
  }],
  dependencies: [{ from: 'api', to: 'mysql' }], // api 调用 mysql
  compatibility: {
    // api@5.0.0 只能与 mysql >=8.1.0 通信；未列出的组合默认兼容。
    // 矩阵双向生效：调用方与被调方任一侧声明不兼容即视为不兼容。
    api: { '5.0.0': { mysql: ['>=8.1.0'] } },
  },
  errorBudgetMinutes: 60,        // 错误预算（累计降级容量·分钟）
  maintenanceWindowMinutes: 180, // 维护窗口
});
```

版本模式支持：`*`、精确版本、`1.2.x`、`^1.2.0`、`~1.2.0`、`>=1.0 <2.0` 组合比较器。

## 输出

```js
{
  feasible,              // 是否全部服务都可安全升级
  batches: [{
    index, services,     // 批次顺序与服务清单
    forcedGroups,        // 批内强制并行组（依赖环 / 互相前置）
    upgradeMinutes, stabilizeMinutes, durationMinutes,
    unavailableMinutes,  // 本批预估降级容量·分钟（计入错误预算）
    cumulativeElapsedMinutes, exceedsWindow,
    rollbackMinutes,     // 回滚本批的预估成本
    notes,               // 共享下游、数据库整体切换等提示
  }],
  mustRunTogether,       // 必须并行的服务及原因
  blocked,               // 被阻塞的服务及阻塞原因
  errorBudget,           // 预算总量 / 消耗 / 剩余 / 是否耗尽
  maintenanceWindow,     // 窗口总量 / 所需 / 是否放得下
  summary,
}
```

## 使用

```bash
node --test          # 运行测试
node examples/demo.js  # 运行示例
```

```js
import { planUpgrade, assessHealth } from './index.js';

const plan = planUpgrade(input);
// 执行过程中根据观测健康度决策：
const decision = assessHealth(service, observedHealthyRatio);
// decision.action: 'proceed' | 'pause' | 'rollback'
```

## 测试

`node --test` 覆盖：线性依赖、多服务并行、不兼容版本、错误预算耗尽、
依赖环、互相版本约束、回滚/暂停决策、数据库不允许并存、维护窗口超限、
多版本并存窗口、共享下游。

// 供需匹配：硬约束逐项重新推导，结论必须由核对结果得出，理由必须能追溯到披露字段。
//
// 平台不允许直接采信服务商演示或人工结论；本模块根据企业档案与产品披露重新计算
// 每一项 check，再与匹配记录中声称的 satisfied 比对，任何不一致都视为资料错误。

const HARD_CHECK_KEYS = [
  "industry_applicable",
  "pain_process_supported",
  "downtime_window_sufficient",
  "budget_sufficient",
  "prerequisites_met",
];

const ALL_CHECK_KEYS = [
  ...HARD_CHECK_KEYS,
  "target_metric_covered",
  "verifiable_case_exists",
];

function computeChecks(ent, product) {
  const c = ent.constraints;
  const satisfied = {};
  const basis = {};

  satisfied.industry_applicable = product.applicable_industries.includes(ent.industry_id);
  basis.industry_applicable =
    `applicable_industries=${product.applicable_industries.join("|")} vs industry_id=${ent.industry_id}`;

  satisfied.pain_process_supported = product.supported_processes.includes(c.pain_process_id);
  basis.pain_process_supported =
    `supported_processes 含痛点工序 ${c.pain_process_id}: ${satisfied.pain_process_supported}`;

  satisfied.downtime_window_sufficient =
    product.prerequisites.required_downtime_hours <= c.max_downtime_hours_per_window;
  basis.downtime_window_sufficient =
    `所需停机 ${product.prerequisites.required_downtime_hours}h vs 窗口上限 ${c.max_downtime_hours_per_window}h`;

  satisfied.budget_sufficient = product.pricing.total_amount <= c.budget_cap;
  basis.budget_sufficient =
    `报价 ${product.pricing.total_amount}（版本 ${product.pricing.version}）vs 预算上限 ${c.budget_cap}`;

  const needsIsolation = c.network_segmentation_required === true;
  const supportsIntranet = product.prerequisites.network_requirements.some((r) =>
    /内网|独立网段|本地/.test(r),
  );
  const requiresPublicCloud = product.prerequisites.network_requirements.some((r) =>
    /公网/.test(r),
  );
  satisfied.prerequisites_met = !(needsIsolation && requiresPublicCloud && !supportsIntranet);
  basis.prerequisites_met =
    `网段隔离要求=${needsIsolation}，持续公网要求=${requiresPublicCloud}，支持内网=${supportsIntranet}`;

  const targetMetrics = new Set(ent.targets.map((t) => t.metric_id));
  const claimMetrics = new Set(product.capability_claims.map((cl) => cl.metric_id));
  satisfied.target_metric_covered = [...targetMetrics].every((m) => claimMetrics.has(m));
  basis.target_metric_covered =
    `目标指标 [${[...targetMetrics].join(",")}] 被能力声明 [${[...claimMetrics].join(",")}] 覆盖: ${satisfied.target_metric_covered}`;

  // 可验证案例：同行业、同痛点工序，且客户可回访；服务商自述且不可回访不算。
  satisfied.verifiable_case_exists = product.verifiable_cases.some(
    (kase) =>
      kase.industry_id === ent.industry_id &&
      kase.process_id === c.pain_process_id &&
      kase.contactable === true,
  );
  basis.verifiable_case_exists =
    `同行业同痛点工序且 contactable 的案例: ${satisfied.verifiable_case_exists}`;

  return { satisfied, basis };
}

function deriveRecommendation(satisfied) {
  if (HARD_CHECK_KEYS.some((k) => !satisfied[k])) {
    return "reject";
  }
  if (!satisfied.target_metric_covered || !satisfied.verifiable_case_exists) {
    return "conditional";
  }
  return "proceed";
}

export function evaluateMatch(ent, product) {
  const { satisfied, basis } = computeChecks(ent, product);
  return {
    checks: satisfied,
    basis,
    recommendation: deriveRecommendation(satisfied),
  };
}

export function validateMatches(doc, ent, products) {
  const results = [];
  for (const m of doc.matches) {
    if (m.enterprise_id !== ent.enterprise_id) {
      throw new Error(`匹配 ${m.match_id} 企业编号与企业档案不一致`);
    }
    const product = products.get(m.product_id);
    if (!product) {
      throw new Error(`匹配 ${m.match_id} 引用了未登记产品: ${m.product_id}`);
    }

    const evaluation = evaluateMatch(ent, product);

    const recorded = new Map(m.checks.map((c) => [c.check_key, c]));
    for (const key of ALL_CHECK_KEYS) {
      if (!recorded.has(key)) {
        throw new Error(`匹配 ${m.match_id} 缺少核对项: ${key}`);
      }
      if (recorded.get(key).satisfied !== evaluation.checks[key]) {
        throw new Error(
          `匹配 ${m.match_id} 核对项 ${key} 的结论与档案/披露重新推导结果不一致 ` +
            `（记录=${recorded.get(key).satisfied}，推导=${evaluation.checks[key]}；依据：${evaluation.basis[key]}）`,
        );
      }
      const src = recorded.get(key).evidence_source;
      if (!src || src.trim().length === 0) {
        throw new Error(`匹配 ${m.match_id} 核对项 ${key} 缺少可追溯的 evidence_source`);
      }
    }
    if (recorded.size !== ALL_CHECK_KEYS.length) {
      throw new Error(`匹配 ${m.match_id} 存在多余或重复的核对项`);
    }

    if (!Array.isArray(m.reasons) || m.reasons.length === 0) {
      throw new Error(`匹配 ${m.match_id} 缺少说明理由`);
    }
    if (m.recommendation !== evaluation.recommendation) {
      throw new Error(
        `匹配 ${m.match_id} 推荐结论 ${m.recommendation} 与核对结果推导出的 ${evaluation.recommendation} 不一致`,
      );
    }

    results.push({ match: m, evaluation });
  }
  return results;
}

// 领域不变量校验：在 JSON 结构合法的前提下，检查跨文档引用与业务规则。
// 所有校验函数在发现问题时抛出聚合后的 Error，字段名与 contracts/*.schema.json 对齐。

function parseJson(raw) {
  return JSON.parse(raw);
}

function indexProducts(productsDoc) {
  const providers = new Map(productsDoc.providers.map((p) => [p.id, p]));
  const products = new Map();
  const quoteVersions = new Map();
  for (const provider of productsDoc.providers) {
    for (const product of provider.products) {
      products.set(product.id, { product, provider });
      for (const quote of product.pricing_versions) {
        quoteVersions.set(quote.id, { quote, product, provider });
      }
    }
  }
  return { providers, products, quoteVersions };
}

function assert(condition, errors, message) {
  if (!condition) errors.push(message);
}

function validateEnterprise(profile) {
  const errors = [];
  const metrics = new Map();
  for (const metric of profile.production_line.baseline.metrics) {
    metrics.set(metric.id, metric);
    assert(metric.source && metric.source.length > 0, errors, `基线指标 ${metric.id} 缺少实测来源`);
    assert(Array.isArray(metric.evidence_refs) && metric.evidence_refs.length > 0, errors, `基线指标 ${metric.id} 缺少证据引用`);
  }
  const evidenceIds = new Set(profile.evidence_vault.map((e) => e.id));
  for (const metric of profile.production_line.baseline.metrics) {
    for (const ref of metric.evidence_refs) {
      assert(evidenceIds.has(ref), errors, `基线指标 ${metric.id} 引用了不存在的证据 ${ref}`);
    }
  }
  for (const target of profile.targets) {
    assert(metrics.has(target.metric_id), errors, `目标 ${target.id} 必须引用本企业实测基线指标，实际引用 ${target.metric_id}`);
    const metric = metrics.get(target.metric_id);
    if (metric) {
      assert(metric.unit === target.unit, errors, `目标 ${target.id} 计量单位与基线不一致`);
      const improving = target.direction === "increase" ? target.target_value > metric.value : target.target_value < metric.value;
      assert(improving, errors, `目标 ${target.id} 的方向/取值相对基线 ${metric.id}=${metric.value} 不构成改善`);
    }
  }
  for (const evidence of profile.evidence_vault) {
    assert(evidence.retained_by_enterprise === true, errors, `证据 ${evidence.id} 必须归企业保留`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return profile;
}

function validateIndustry(benchmarks) {
  const errors = [];
  assert(benchmarks.usage === "comparison_only", errors, "行业资料 usage 必须为 comparison_only");
  if (errors.length) throw new Error(errors.join("\n"));
  return benchmarks;
}

function validateProducts(productsDoc) {
  const errors = [];
  const seenProduct = new Set();
  for (const provider of productsDoc.providers) {
    for (const product of provider.products) {
      assert(!seenProduct.has(product.id), errors, `产品标识重复：${product.id}`);
      seenProduct.add(product.id);

      const activeQuotes = product.pricing_versions.filter((q) => q.status === "active");
      assert(activeQuotes.length === 1, errors, `产品 ${product.id} 必须恰有一个生效报价，实际 ${activeQuotes.length} 个`);

      for (const quote of product.pricing_versions) {
        assert(typeof quote.first_year_total_cny === "number" && quote.first_year_total_cny >= 0, errors, `报价 ${quote.id} 首年费用非法`);
        if (quote.status === "superseded") {
          assert(quote.valid_to != null, errors, `被替代报价 ${quote.id} 必须给出有效期截止日`);
        }
      }

      const hardPrereqs = product.implementation_prerequisites.filter((p) => p.severity === "hard");
      assert(hardPrereqs.length > 0, errors, `产品 ${product.id} 至少披露一条硬性实施前提`);
      assert(product.capability_boundary.does_not.length > 0, errors, `产品 ${product.id} 必须披露能力边界（does_not 不能为空）`);

      for (const c of product.verifiable_cases) {
        assert(c.verification.artifact_ref && c.verification.method, errors, `案例 ${c.id} 缺少可核验方式或材料`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return productsDoc;
}

function validateMatching(match, profile, productsDoc) {
  const errors = [];
  const { products, quoteVersions } = indexProducts(productsDoc);
  const metricIds = new Set(profile.production_line.baseline.metrics.map((m) => m.id));
  const maxWindow = Math.max(...profile.constraints.shutdown_windows.map((w) => w.max_continuous_hours));
  const budgetCap = profile.constraints.budget.first_year_cap_cny;

  assert(match.industry_usage === "comparison_only", errors, "匹配结论中行业均值只能标记为 comparison_only");

  const benchmarkIds = new Set();
  for (const comparison of match.industry_comparison ?? []) {
    benchmarkIds.add(comparison.benchmark_ref);
    assert(comparison.usage === "comparison_only", errors, `行业对比 ${comparison.benchmark_ref} 必须为 comparison_only`);
    assert(metricIds.has(comparison.baseline_ref), errors, `行业对比 ${comparison.benchmark_ref} 未对照企业实测基线`);
  }

  for (const candidate of match.candidates) {
    const entry = products.get(candidate.product_ref);
    assert(entry != null, errors, `候选 ${candidate.product_ref} 未在产品披露中找到`);
    if (!entry) continue;
    assert(entry.provider.id === candidate.provider_ref, errors, `候选 ${candidate.product_ref} 的服务商归属不一致`);

    for (const dimension of candidate.dimensions) {
      assert(dimension.reason && dimension.reason.length > 0, errors, `候选 ${candidate.product_ref} 维度 ${dimension.key} 缺少理由`);
    }

    if (candidate.verdict === "reject") {
      assert((candidate.hard_blockers ?? []).length > 0, errors, `被拒候选 ${candidate.product_ref} 必须列出硬性阻断项`);
    }
    if (candidate.verdict === "recommend") {
      const failDimensions = candidate.dimensions.filter((d) => d.rating === "fail").map((d) => d.key);
      assert(failDimensions.length === 0, errors, `推荐候选 ${candidate.product_ref} 存在 fail 维度：${failDimensions.join(",")}`);

      const { product } = entry;
      assert(
        product.shutdown_requirement.requires_continuous_hours <= maxWindow ||
          (product.shutdown_requirement.batchable && product.shutdown_requirement.requires_continuous_hours <= maxWindow),
        errors,
        `推荐候选 ${product.id} 的连续停机需求超过企业最长窗口 ${maxWindow} 小时`
      );
      const activeQuote = product.pricing_versions.find((q) => q.status === "active");
      assert(activeQuote.first_year_total_cny <= budgetCap, errors, `推荐候选 ${product.id} 生效报价首年 ${activeQuote.first_year_total_cny} 超出预算 ${budgetCap}`);
    }
  }

  for (const effect of match.expected_effects ?? []) {
    assert(metricIds.has(effect.baseline_ref), errors, `预期效果必须引用企业实测基线，${effect.product_ref} 实际引用 ${effect.baseline_ref}`);
    assert(!benchmarkIds.has(effect.baseline_ref), errors, `预期效果 ${effect.product_ref} 不得引用行业均值`);
    assert(effect.binding === false, errors, `预期效果 ${effect.product_ref} 在尽调阶段不得构成承诺（binding 必须为 false）`);
    assert(products.has(effect.product_ref), errors, `预期效果引用了不存在的产品 ${effect.product_ref}`);
  }

  const recommended = match.candidates.find((c) => c.product_ref === match.recommendation.product_ref);
  assert(recommended != null, errors, "推荐结论必须出自候选列表");
  assert(recommended && recommended.verdict === "recommend", errors, "推荐结论只能指向 verdict=recommend 的候选");

  for (const candidate of match.candidates) {
    for (const dimension of candidate.dimensions) {
      if (dimension.disclosure_ref && dimension.disclosure_ref.includes("quote-")) {
        assert(quoteVersions.has(dimension.disclosure_ref), errors, `维度理由引用了不存在的报价版本 ${dimension.disclosure_ref}`);
      }
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));
  return match;
}

function validateEngagement(ledgerDoc, profile, productsDoc) {
  const errors = [];
  const { products, quoteVersions } = indexProducts(productsDoc);
  // 企业可保留证据 = 签约前自有证据仓 ∪ 账本中登记并标记归企业的证据
  const enterpriseEvidence = new Set(profile.evidence_vault.map((e) => e.id));
  for (const event of ledgerDoc.ledger) {
    if (event.type === "evidence_registered" && event.payload?.retained_by_enterprise === true) {
      enterpriseEvidence.add(event.payload.evidence_ref);
    }
  }

  // 并行尽调
  assert(ledgerDoc.due_diligence.parallel === true, errors, "尽调必须标记为多家并行");
  assert(ledgerDoc.due_diligence.tracks.length >= 2, errors, "并行尽调至少包含两家服务商");
  for (const track of ledgerDoc.due_diligence.tracks) {
    assert(products.has(track.product_ref), errors, `尽调轨道 ${track.id} 引用了不存在的产品`);
    if (track.quote_version_ref) {
      assert(quoteVersions.has(track.quote_version_ref), errors, `尽调轨道 ${track.id} 引用了不存在的报价版本`);
    }
  }

  const engagementIds = new Set();
  const subsidyState = new Map();
  for (const engagement of ledgerDoc.engagements) {
    assert(!engagementIds.has(engagement.id), errors, `签约记录标识重复：${engagement.id}`);
    engagementIds.add(engagement.id);
    assert(products.has(engagement.product_ref), errors, `签约 ${engagement.id} 引用了不存在的产品`);
    assert(quoteVersions.has(engagement.quote_version_ref), errors, `签约 ${engagement.id} 必须锁定具体报价版本`);

    for (const stage of engagement.stages) {
      if (stage.status === "accepted") {
        assert(stage.decided_at != null, errors, `阶段 ${stage.id} 已验收但缺少决定时间`);
        assert((stage.evidence_refs ?? []).length > 0, errors, `阶段 ${stage.id} 已验收但缺少证据`);
      }
      if (stage.status === "rejected") {
        assert(stage.rejection_reason, errors, `阶段 ${stage.id} 驳回必须写明理由`);
      }
    }

    // 补贴占用：同一补贴同一时点不可被两个项目占用；累计拨付不得超额。
    for (const occupation of engagement.subsidy_occupations) {
      const state = subsidyState.get(occupation.subsidy_ref) ?? [];
      for (const other of state) {
        const otherEnd = other.released_at ?? "9999-12-31";
        const end = occupation.released_at ?? "9999-12-31";
        const overlap = occupation.reserved_at < otherEnd && other.reserved_at < end;
        assert(!overlap, errors, `补贴 ${occupation.subsidy_ref} 在 ${occupation.reserved_at} 存在重复占用`);
      }
      state.push(occupation);
      subsidyState.set(occupation.subsidy_ref, state);
      assert(occupation.disbursed_cny <= occupation.amount_cny, errors, `补贴占用 ${occupation.id} 拨付超过预留额度`);
      if (occupation.status === "partially_disbursed") {
        assert(occupation.disbursed_cny > 0 && occupation.disbursed_cny < occupation.amount_cny, errors, `补贴占用 ${occupation.id} 状态与拨付金额不符`);
        assert(occupation.released_at == null, errors, `补贴占用 ${occupation.id} 部分拨付时不得标记释放`);
      }
      if (occupation.status === "released_closed") {
        assert(occupation.released_at != null && occupation.disbursed_cny === 0, errors, `失败退出的补贴占用 ${occupation.id} 应零拨付并释放`);
      }
    }

    // 数据授权与失败退出
    for (const grant of engagement.data_grants) {
      assert(grant.datasets.length > 0, errors, `数据授权 ${grant.id} 未限定数据集`);
      if (engagement.status === "terminated_failure_exit") {
        assert(grant.status === "revoked" && grant.revoked_at != null, errors, `失败退出后数据授权 ${grant.id} 必须已撤销`);
      }
    }
    if (engagement.status === "terminated_failure_exit") {
      assert(engagement.exit?.type === "failure_exit", errors, `签约 ${engagement.id} 标记失败退出但缺少 exit 记录`);
      assert(engagement.exit?.reason_evidence_ref, errors, `签约 ${engagement.id} 失败退出缺少原因证据`);
      assert(engagement.exit?.data_destruction_evidence_ref, errors, `签约 ${engagement.id} 失败退出缺少数据删除证据`);
      const released = engagement.subsidy_occupations.every((o) => o.status === "released_closed");
      assert(released, errors, `签约 ${engagement.id} 失败退出后补贴必须释放`);
    }
  }

  // 更换服务商：企业证据必须保留
  if (ledgerDoc.provider_switch) {
    const sw = ledgerDoc.provider_switch;
    assert(engagementIds.has(sw.from_engagement_ref) && engagementIds.has(sw.to_engagement_ref), errors, "更换服务商引用的签约记录不存在");
    for (const ref of sw.evidence_retained_by_enterprise) {
      assert(enterpriseEvidence.has(ref), errors, `更换服务商时保留的证据 ${ref} 不在企业证据仓中`);
    }
  }

  // 事件账本：唯一、时序、类型与引用
  const allowedTypes = new Set(ledgerDoc.event_types);
  const seenEvent = new Set();
  let previousAt = null;
  const disbursedByOccupation = new Map();
  for (const event of ledgerDoc.ledger) {
    assert(!seenEvent.has(event.id), errors, `账本事件标识重复：${event.id}`);
    seenEvent.add(event.id);
    assert(allowedTypes.has(event.type), errors, `账本事件 ${event.id} 类型未登记：${event.type}`);
    if (previousAt) assert(event.at >= previousAt, errors, `账本事件 ${event.id} 早于前一事件，时序必须追加`);
    previousAt = event.at;
    if (event.engagement_ref) assert(engagementIds.has(event.engagement_ref), errors, `事件 ${event.id} 引用了不存在的签约记录`);
    if (event.type === "contract_signed") {
      const quoteRef = event.payload?.quote_version_ref;
      assert(quoteVersions.has(quoteRef), errors, `签约事件 ${event.id} 引用了不存在的报价版本 ${quoteRef}`);
    }
    if (event.type === "metric_change") {
      const metricRef = event.payload?.metric_ref;
      assert(profile.production_line.baseline.metrics.some((m) => m.id === metricRef), errors, `指标变化事件 ${event.id} 必须引用企业基线指标 ${metricRef}`);
      assert(event.payload?.baseline_value != null, errors, `指标变化事件 ${event.id} 必须同时记录基线值`);
    }
    if (event.type === "sustained_use") {
      assert(event.payload?.report_retained_by_enterprise === true, errors, `持续使用事件 ${event.id} 的使用报告必须归企业留存`);
      assert(typeof event.payload?.record_coverage_pct === "number", errors, `持续使用事件 ${event.id} 缺少记录覆盖率`);
    }
    if (event.type === "evidence_registered") {
      assert(event.payload?.retained_by_enterprise === true, errors, `证据登记事件 ${event.id} 必须归企业保留`);
    }
    if (event.type === "subsidy_disbursed") {
      const occupationRef = event.payload?.occupation_ref;
      const sum = (disbursedByOccupation.get(occupationRef) ?? 0) + (event.payload?.amount_cny ?? NaN);
      disbursedByOccupation.set(occupationRef, sum);
    }
  }

  // 账本累计拨付必须与占用记录中的拨付额一致
  for (const engagement of ledgerDoc.engagements) {
    for (const occupation of engagement.subsidy_occupations) {
      const ledgerSum = disbursedByOccupation.get(occupation.id) ?? 0;
      assert(ledgerSum === occupation.disbursed_cny, errors, `补贴占用 ${occupation.id} 账本累计拨付 ${ledgerSum} 与记录 ${occupation.disbursed_cny} 不一致`);
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));
  return ledgerDoc;
}

// 账本查询助手：签约、部署、指标变化、持续使用分类型可查。
function eventsByType(ledgerDoc, type) {
  return ledgerDoc.ledger.filter((e) => e.type === type);
}

function eventsByEngagement(ledgerDoc, engagementId) {
  return ledgerDoc.ledger.filter((e) => e.engagement_ref === engagementId);
}

export {
  parseJson,
  indexProducts,
  validateEnterprise,
  validateIndustry,
  validateProducts,
  validateMatching,
  validateEngagement,
  eventsByType,
  eventsByEngagement,
};

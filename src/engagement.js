// 合作全生命周期校验：
// 并行尽调、补贴占用、阶段验收、指标变化、持续使用、失败退出、商业数据隔离与证据归属。

// 记录类型对应的证据种类，保证每一步都有正确形态的凭证。
const RECORD_EVIDENCE_KIND = {
  signing: "signed_document",
  deployment: "system_log_export",
  metric_reading: "measured_reading",
  stage_acceptance: "signed_document",
  usage_log: "system_log_export",
  failure_exit: "signed_document",
  data_export: "export_manifest",
  provider_data_deletion: "deletion_confirmation",
};

// 各状态要求的进展记录（含状态本身及之前必须存在的记录类型）。
const STATE_REQUIRED_RECORDS = {
  due_diligence: [],
  contracted: ["signing"],
  deployed: ["signing", "deployment"],
  stage_accepted: ["signing", "deployment", "stage_acceptance"],
  in_use: ["signing", "deployment", "stage_acceptance"],
  exited_failed: ["failure_exit", "data_export", "provider_data_deletion"],
  exited_completed: ["signing", "deployment", "stage_acceptance"],
};

function pctChange(baseline, current) {
  return ((current - baseline) / baseline) * 100;
}

export function validateEngagements(doc, ent, products, matchResults, catalog) {
  const matchByProduct = new Map(matchResults.map((r) => [r.match.product_id, r]));
  const activeSubsidyByProgram = new Map();

  const summaries = [];

  for (const eng of doc.engagements) {
    if (eng.enterprise_id !== ent.enterprise_id) {
      throw new Error(`合作 ${eng.engagement_id} 企业编号与企业档案不一致`);
    }
    const product = products.get(eng.product_id);
    if (!product) {
      throw new Error(`合作 ${eng.engagement_id} 引用了未登记产品: ${eng.product_id}`);
    }
    if (product.provider_id !== eng.provider_id) {
      throw new Error(`合作 ${eng.engagement_id} 服务商编号与产品披露不一致`);
    }
    const matchResult = matchByProduct.get(eng.product_id);
    if (!matchResult || matchResult.match.match_id !== eng.match_id) {
      throw new Error(`合作 ${eng.engagement_id} 引用的匹配记录不存在或编号不一致`);
    }

    // 商业数据隔离与证据归属是不可协商的平台底线。
    if (eng.data_isolation.commercial_data_visible_to_provider !== false) {
      throw new Error(`合作 ${eng.engagement_id} 未隔离商业数据：服务商可见企业商业数据`);
    }
    const iso = eng.data_isolation;
    if (!iso.tenant_scope || !iso.separation_mechanism) {
      throw new Error(`合作 ${eng.engagement_id} 缺少租户隔离范围或隔离机制说明`);
    }
    const own = eng.evidence_ownership;
    if (own.enterprise_owns_evidence !== true || own.portable_on_switch !== true || !own.export_format) {
      throw new Error(`合作 ${eng.engagement_id} 证据不归属企业或不可携带，企业换商将失去证据`);
    }

    // 补贴占用：同一企业同一政策同时只能有一笔未释放占用，防止重复申领。
    if (eng.subsidy) {
      const key = `${eng.enterprise_id}/${eng.subsidy.program_id}`;
      if (eng.subsidy.occupancy !== "released") {
        if (activeSubsidyByProgram.has(key)) {
          throw new Error(`企业 ${eng.enterprise_id} 在政策 ${eng.subsidy.program_id} 上存在重复补贴占用`);
        }
        activeSubsidyByProgram.set(key, eng.engagement_id);
      }
      if (eng.state === "exited_failed" && eng.subsidy.occupancy !== "released") {
        throw new Error(`合作 ${eng.engagement_id} 已失败退出，补贴占用必须释放`);
      }
      if (eng.subsidy.reserved_at < eng.started_at) {
        throw new Error(`合作 ${eng.engagement_id} 补贴占用时间早于尽调开始时间`);
      }
    }

    const records = [...eng.records].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const kinds = new Set(records.map((r) => r.kind));
    const recordIds = new Set();

    let prevAt = "";
    let acceptancePassed = false;
    for (const r of records) {
      if (recordIds.has(r.record_id)) {
        throw new Error(`合作 ${eng.engagement_id} 记录编号重复: ${r.record_id}`);
      }
      recordIds.add(r.record_id);
      if (r.at < prevAt) {
        throw new Error(`合作 ${eng.engagement_id} 记录 ${r.record_id} 时间早于前一条记录`);
      }
      prevAt = r.at;

      if (r.at < eng.started_at) {
        throw new Error(`合作 ${eng.engagement_id} 记录 ${r.record_id} 早于合作开始时间`);
      }

      const ev = catalog.evidence.get(r.evidence_id);
      if (!ev) {
        throw new Error(`合作 ${eng.engagement_id} 记录 ${r.record_id} 引用证据未登记: ${r.evidence_id}`);
      }
      const expectedKind = RECORD_EVIDENCE_KIND[r.kind];
      if (ev.kind !== expectedKind) {
        throw new Error(
          `合作 ${eng.engagement_id} 记录 ${r.record_id}（${r.kind}）证据类型应为 ${expectedKind}，实际为 ${ev.kind}`,
        );
      }
      if (r.kind === "stage_acceptance") {
        if (typeof r.passed !== "boolean") {
          throw new Error(`合作 ${eng.engagement_id} 阶段验收记录 ${r.record_id} 必须给出 passed 结论`);
        }
        acceptancePassed = acceptancePassed || r.passed;
      }
    }

    // 状态必须由实际进展记录支撑，不能空口声称已部署/已验收。
    for (const required of STATE_REQUIRED_RECORDS[eng.state]) {
      if (!kinds.has(required)) {
        throw new Error(`合作 ${eng.engagement_id} 状态为 ${eng.state}，但缺少记录: ${required}`);
      }
    }
    if ((eng.state === "stage_accepted" || eng.state === "in_use" || eng.state === "exited_completed") && !acceptancePassed) {
      throw new Error(`合作 ${eng.engagement_id} 状态为 ${eng.state}，但没有通过的阶段验收`);
    }
    if (kinds.has("signing") && matchResult.evaluation.recommendation === "reject") {
      throw new Error(`合作 ${eng.engagement_id} 在匹配结论为 reject 的情况下签署了合同`);
    }

    // 指标变化：相对企业实测基线计算，绝不使用行业参照值。
    const metricChanges = [];
    for (const r of records.filter((r) => r.kind === "metric_reading")) {
      const line = ent.production_lines.find((l) => l.line_id === r.line_id);
      if (!line) {
        throw new Error(`合作 ${eng.engagement_id} 读数 ${r.record_id} 引用了不存在的产线`);
      }
      if (!catalog.metrics.has(r.metric_id)) {
        throw new Error(`合作 ${eng.engagement_id} 读数 ${r.record_id} 指标未登记`);
      }
      const baseline = ent.baselines.find(
        (b) => b.line_id === r.line_id && b.metric_id === r.metric_id && b.basis === "enterprise_measured",
      );
      if (!baseline) {
        throw new Error(`合作 ${eng.engagement_id} 读数 ${r.record_id} 缺少企业实测基线，无法计算变化`);
      }
      if (r.at <= baseline.measured_at) {
        throw new Error(`合作 ${eng.engagement_id} 读数 ${r.record_id} 时间必须晚于基线测量时间`);
      }
      const changePct = pctChange(baseline.value, r.value);
      const target = ent.targets.find(
        (t) => t.line_id === r.line_id && t.metric_id === r.metric_id,
      );
      metricChanges.push({
        record_id: r.record_id,
        line_id: r.line_id,
        metric_id: r.metric_id,
        baseline: baseline.value,
        current: r.value,
        change_pct: Number(changePct.toFixed(2)),
        target_value: target ? target.target_value : null,
      });
    }

    summaries.push({ engagement: eng, records, metricChanges, kinds });
  }

  return summaries;
}

// 按记录类型查询（签约、部署、指标变化、验收、持续使用分别可查）。
export function recordsByKind(summary, kind) {
  return summary.records.filter((r) => r.kind === kind);
}

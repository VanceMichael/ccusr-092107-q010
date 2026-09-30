// 企业档案校验：引用完整性，以及"基线必须企业实测、行业均值不得冒充现状"。
export function validateEnterprise(doc, catalog) {
  const ent = doc.enterprise;

  if (!catalog.industries.has(ent.industry_id)) {
    throw new Error(`企业行业编号未登记: ${ent.industry_id}`);
  }

  const lineIds = new Set();
  for (const line of ent.production_lines) {
    if (lineIds.has(line.line_id)) {
      throw new Error(`产线编号重复: ${line.line_id}`);
    }
    lineIds.add(line.line_id);
    if (!catalog.processes.has(line.process_id)) {
      throw new Error(`产线 ${line.line_id} 的工序未登记: ${line.process_id}`);
    }
  }

  if (!catalog.processes.has(ent.constraints.pain_process_id)) {
    throw new Error(`痛点工序未登记: ${ent.constraints.pain_process_id}`);
  }

  const measuredPairs = new Set();
  let hasMeasuredBaseline = false;
  for (const b of ent.baselines) {
    if (!lineIds.has(b.line_id)) {
      throw new Error(`基线引用了不存在的产线: ${b.line_id}`);
    }
    if (!catalog.metrics.has(b.metric_id)) {
      throw new Error(`基线指标未登记: ${b.metric_id}`);
    }
    if (!catalog.evidence.has(b.evidence_id)) {
      throw new Error(`基线证据未登记: ${b.evidence_id}`);
    }
    const pair = `${b.line_id}/${b.metric_id}`;
    if (measuredPairs.has(pair) && b.basis === "enterprise_measured") {
      throw new Error(`同一产线指标存在多条实测基线: ${pair}`);
    }
    if (b.basis === "enterprise_measured") {
      hasMeasuredBaseline = true;
      measuredPairs.add(pair);
    }
    const ev = catalog.evidence.get(b.evidence_id);
    if (b.basis === "enterprise_measured" && ev.kind !== "measured_reading") {
      throw new Error(`实测基线 ${pair} 必须引用 measured_reading 证据，实际为 ${ev.kind}`);
    }
    if (b.basis === "industry_reference" && ev.kind !== "third_party_report") {
      throw new Error(`行业参照基线 ${pair} 应引用 third_party_report 证据`);
    }
  }
  if (!hasMeasuredBaseline) {
    throw new Error("企业档案至少需要一条 enterprise_measured 实测基线，行业均值不能替代");
  }

  for (const t of ent.targets) {
    if (!lineIds.has(t.line_id)) {
      throw new Error(`目标引用了不存在的产线: ${t.line_id}`);
    }
    if (!catalog.metrics.has(t.metric_id)) {
      throw new Error(`目标指标未登记: ${t.metric_id}`);
    }
    const pair = `${t.line_id}/${t.metric_id}`;
    if (!measuredPairs.has(pair)) {
      throw new Error(`目标 ${pair} 缺少同产线同指标的实测基线，无法衡量改善`);
    }
  }

  return ent;
}

// 取某产线某指标的企业实测基线；不存在返回 undefined（行业参照值永不由此返回）。
export function measuredBaseline(ent, lineId, metricId) {
  return ent.baselines.find(
    (b) => b.line_id === lineId && b.metric_id === metricId && b.basis === "enterprise_measured",
  );
}

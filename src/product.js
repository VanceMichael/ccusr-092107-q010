// 产品披露校验：能力边界、实施前提、报价版本与案例都必须可追溯。
export function validateProducts(doc, catalog) {
  const products = new Map();
  for (const p of doc.products) {
    if (products.has(p.product_id)) {
      throw new Error(`产品编号重复: ${p.product_id}`);
    }

    for (const industryId of p.applicable_industries) {
      if (!catalog.industries.has(industryId)) {
        throw new Error(`产品 ${p.product_id} 适用行业未登记: ${industryId}`);
      }
    }
    for (const processId of p.supported_processes) {
      if (!catalog.processes.has(processId)) {
        throw new Error(`产品 ${p.product_id} 支持工序未登记: ${processId}`);
      }
    }

    for (const claim of p.capability_claims) {
      if (!catalog.metrics.has(claim.metric_id)) {
        throw new Error(`产品 ${p.product_id} 能力声明指标未登记: ${claim.metric_id}`);
      }
      const { direction, min_percent, max_percent } = claim.expected_effect;
      if (min_percent < 0 || max_percent < 0 || min_percent > max_percent) {
        throw new Error(`产品 ${p.product_id} 声明 ${claim.claim_id} 的效果区间不合法`);
      }
      if (max_percent > 100 && direction === "decrease") {
        throw new Error(`产品 ${p.product_id} 声明 ${claim.claim_id} 下降幅度超过 100%`);
      }
      if (claim.case_evidence_id && !catalog.evidence.has(claim.case_evidence_id)) {
        throw new Error(`产品 ${p.product_id} 声明引用案例证据未登记: ${claim.case_evidence_id}`);
      }
    }

    if (!p.pricing.version || p.pricing.total_amount <= 0) {
      throw new Error(`产品 ${p.product_id} 报价缺少版本或金额非法`);
    }

    for (const c of p.verifiable_cases) {
      if (!catalog.industries.has(c.industry_id) || !catalog.processes.has(c.process_id)) {
        throw new Error(`产品 ${p.product_id} 案例 ${c.case_id} 行业/工序未登记`);
      }
      const ev = catalog.evidence.get(c.evidence_id);
      if (!ev) {
        throw new Error(`产品 ${p.product_id} 案例证据未登记: ${c.evidence_id}`);
      }
      if (ev.kind !== "case_reference") {
        throw new Error(`产品 ${p.product_id} 案例 ${c.case_id} 证据类型必须为 case_reference`);
      }
    }

    products.set(p.product_id, p);
  }
  return products;
}

// 行业/工序/指标目录与证据登记册的索引和一致性检查。
export function buildCatalog(industriesDoc, evidenceDoc) {
  const industries = new Map();
  const processes = new Map();
  const metrics = new Map();

  // 工序、指标可以是跨行业共享的同名概念（如成品检验、漏检率）：
  // 编号重复只在名称或计量口径不一致时才算错误。
  for (const ind of industriesDoc.industries) {
    if (industries.has(ind.industry_id)) {
      throw new Error(`行业编号重复: ${ind.industry_id}`);
    }
    industries.set(ind.industry_id, ind);
    for (const proc of ind.processes) {
      const existing = processes.get(proc.process_id);
      if (existing && existing.name !== proc.name) {
        throw new Error(`工序编号 ${proc.process_id} 在不同行业中名称不一致`);
      }
      processes.set(proc.process_id, proc);
    }
    for (const metric of ind.metrics) {
      const existing = metrics.get(metric.metric_id);
      if (
        existing &&
        (existing.name !== metric.name ||
          existing.unit !== metric.unit ||
          existing.direction !== metric.direction)
      ) {
        throw new Error(`指标编号 ${metric.metric_id} 在不同行业中名称或计量口径不一致`);
      }
      metrics.set(metric.metric_id, metric);
    }
  }

  const evidence = new Map();
  for (const ev of evidenceDoc.evidence) {
    if (evidence.has(ev.evidence_id)) {
      throw new Error(`证据编号重复: ${ev.evidence_id}`);
    }
    evidence.set(ev.evidence_id, ev);
  }

  return { industries, processes, metrics, evidence };
}

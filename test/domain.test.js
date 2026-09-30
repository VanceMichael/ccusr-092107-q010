import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { loadFixture } from "../src/io.js";
import { buildCatalog } from "../src/catalog.js";
import { validateEnterprise } from "../src/enterprise.js";
import { validateProducts } from "../src/product.js";
import { validateMatches, evaluateMatch } from "../src/matching.js";
import { validateEngagements, recordsByKind } from "../src/engagement.js";

function loadAll() {
  return Promise.all([
    loadFixture("industries.json"),
    loadFixture("evidence.json"),
    loadFixture("enterprises.json"),
    loadFixture("products.json"),
    loadFixture("matches.json"),
    loadFixture("engagements.json"),
  ]);
}

test("全部样例资料可读取且通过语义校验", async () => {
  const [industries, evidence, enterpriseDoc, productsDoc, matchesDoc, engagementsDoc] = await loadAll();
  const catalog = buildCatalog(industries, evidence);
  const ent = validateEnterprise(enterpriseDoc, catalog);
  const products = validateProducts(productsDoc, catalog);
  const matchResults = validateMatches(matchesDoc, ent, products);
  const summaries = validateEngagements(engagementsDoc, ent, products, matchResults, catalog);

  assert.equal(ent.enterprise_id, "ent-010");
  assert.equal(products.size, 3);
  assert.deepEqual(
    matchResults.map((r) => [r.match.product_id, r.match.recommendation]),
    [
      ["prod-vision-qc", "proceed"],
      ["prod-cloud-aps", "reject"],
      ["prod-energy-lite", "conditional"],
    ],
  );
  assert.equal(summaries.length, 2);
});

test("基线区分企业实测与行业参照，行业均值不参与现状", async () => {
  const [industries, evidence, enterpriseDoc] = await loadAll();
  const catalog = buildCatalog(industries, evidence);
  const ent = validateEnterprise(enterpriseDoc, catalog);

  const measured = ent.baselines.filter((b) => b.basis === "enterprise_measured");
  const references = ent.baselines.filter((b) => b.basis === "industry_reference");
  assert.equal(measured.length, 4);
  assert.equal(references.length, 1);
  assert.equal(references[0].value, 71);
  assert.equal(references[0].evidence_id, "ev-ref-oee");
});

test("匹配核对可从档案与披露独立重新推导", async () => {
  const [industries, evidence, enterpriseDoc, productsDoc] = await loadAll();
  const catalog = buildCatalog(industries, evidence);
  const ent = validateEnterprise(enterpriseDoc, catalog);
  const products = validateProducts(productsDoc, catalog);

  const vision = evaluateMatch(ent, products.get("prod-vision-qc"));
  assert.equal(vision.recommendation, "proceed");
  assert.equal(vision.checks.downtime_window_sufficient, true);

  const aps = evaluateMatch(ent, products.get("prod-cloud-aps"));
  assert.equal(aps.recommendation, "reject");
  assert.equal(aps.checks.pain_process_supported, false);
  assert.equal(aps.checks.downtime_window_sufficient, false);
  assert.equal(aps.checks.budget_sufficient, false);
  assert.equal(aps.checks.prerequisites_met, false);

  const energy = evaluateMatch(ent, products.get("prod-energy-lite"));
  assert.equal(energy.recommendation, "conditional");
  assert.equal(energy.checks.target_metric_covered, false);
  assert.equal(energy.checks.verifiable_case_exists, false);
});

test("签约、部署、验收、指标变化、持续使用分别可查", async () => {
  const [industries, evidence, enterpriseDoc, productsDoc, matchesDoc, engagementsDoc] = await loadAll();
  const catalog = buildCatalog(industries, evidence);
  const ent = validateEnterprise(enterpriseDoc, catalog);
  const products = validateProducts(productsDoc, catalog);
  const matchResults = validateMatches(matchesDoc, ent, products);
  const summaries = validateEngagements(engagementsDoc, ent, products, matchResults, catalog);

  const vision = summaries.find((s) => s.engagement.engagement_id === "eng-010-vision");
  assert.equal(recordsByKind(vision, "signing").length, 1);
  assert.equal(recordsByKind(vision, "deployment").length, 1);
  assert.equal(recordsByKind(vision, "stage_acceptance").length, 1);
  assert.equal(recordsByKind(vision, "usage_log").length, 1);
  assert.equal(recordsByKind(vision, "metric_reading").length, 2);

  // 检验工时 14.0 -> 9.5：下降 32.14%，落在产品披露的 25%-40% 区间内。
  const hours = vision.metricChanges.find((m) => m.metric_id === "metric-inspection-hours");
  assert.equal(hours.baseline, 14.0);
  assert.equal(hours.current, 9.5);
  assert.ok(hours.change_pct <= -25 && hours.change_pct >= -40);
  assert.equal(hours.target_value, 9.0);

  // 漏检率 2.3 -> 1.1：下降 52.17%，落在披露的 30%-60% 区间内。
  const escape = vision.metricChanges.find((m) => m.metric_id === "metric-defect-escape");
  assert.equal(escape.change_pct, -52.17);
  assert.equal(escape.target_value, 1.0);
});

test("失败退出必须留痕：退出备忘、企业导出、服务商删除确认", async () => {
  const [industries, evidence, enterpriseDoc, productsDoc, matchesDoc, engagementsDoc] = await loadAll();
  const catalog = buildCatalog(industries, evidence);
  const ent = validateEnterprise(enterpriseDoc, catalog);
  const products = validateProducts(productsDoc, catalog);
  const matchResults = validateMatches(matchesDoc, ent, products);
  const summaries = validateEngagements(engagementsDoc, ent, products, matchResults, catalog);

  const exited = summaries.find((s) => s.engagement.engagement_id === "eng-010-aps-dd");
  assert.equal(exited.engagement.state, "exited_failed");
  assert.deepEqual(
    exited.records.map((r) => r.kind),
    ["failure_exit", "data_export", "provider_data_deletion"],
  );
  // 失败尽调未占用补贴，视觉项目的补贴已拨付——同一企业没有重复占用。
  assert.equal(exited.engagement.subsidy, undefined);
  assert.equal(summaries[0].engagement.subsidy.occupancy, "disbursed");
});

test("契约文件均为结构完整的 JSON Schema", async () => {
  const files = [
    "context.schema.json",
    "industry.schema.json",
    "evidence.schema.json",
    "enterprise.schema.json",
    "product.schema.json",
    "match.schema.json",
    "engagement.schema.json",
  ];
  for (const f of files) {
    const schema = JSON.parse(
      await readFile(new URL(`../contracts/${f}`, import.meta.url), "utf8"),
    );
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", f);
    assert.ok(schema.title, f);
  }
});

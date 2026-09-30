import test from "node:test";
import assert from "node:assert/strict";

import { loadFixture } from "../src/io.js";
import { buildCatalog } from "../src/catalog.js";
import { validateEnterprise } from "../src/enterprise.js";
import { validateProducts } from "../src/product.js";
import { validateMatches } from "../src/matching.js";
import { validateEngagements } from "../src/engagement.js";

async function setup() {
  const [industries, evidence, enterpriseDoc, productsDoc, matchesDoc, engagementsDoc] =
    await Promise.all([
      loadFixture("industries.json"),
      loadFixture("evidence.json"),
      loadFixture("enterprises.json"),
      loadFixture("products.json"),
      loadFixture("matches.json"),
      loadFixture("engagements.json"),
    ]);
  const catalog = buildCatalog(industries, evidence);
  return { catalog, enterpriseDoc, productsDoc, matchesDoc, engagementsDoc };
}

function parseEntProducts(d) {
  const ent = validateEnterprise(d.enterpriseDoc, d.catalog);
  const products = validateProducts(d.productsDoc, d.catalog);
  return { ent, products };
}

function validChain(d) {
  const { ent, products } = parseEntProducts(d);
  const matchResults = validateMatches(d.matchesDoc, ent, products);
  return { ent, products, matchResults };
}

test("反例：行业参照值冒充企业现状时被拒绝", async () => {
  const d = await setup();
  // 把检验工时的实测基线改挂到行业报告证据上，目标随即失去实测基线。
  const b = d.enterpriseDoc.enterprise.baselines.find(
    (x) => x.metric_id === "metric-inspection-hours",
  );
  b.basis = "industry_reference";
  b.evidence_id = "ev-ref-oee";
  assert.throws(() => validateEnterprise(d.enterpriseDoc, d.catalog), /实测基线/);
});

test("反例：档案里没有任何实测基线时被拒绝", async () => {
  const d = await setup();
  d.enterpriseDoc.enterprise.baselines = d.enterpriseDoc.enterprise.baselines.filter(
    (b) => b.basis !== "enterprise_measured",
  );
  assert.throws(() => validateEnterprise(d.enterpriseDoc, d.catalog), /enterprise_measured/);
});

test("反例：匹配记录篡改核对结论（停机窗口明明不够却记为满足）被拒绝", async () => {
  const d = await setup();
  const tampered = d.matchesDoc.matches.find((m) => m.product_id === "prod-cloud-aps");
  tampered.checks.find((c) => c.check_key === "downtime_window_sufficient").satisfied = true;
  const { ent, products } = parseEntProducts(d);
  assert.throws(() => validateMatches(d.matchesDoc, ent, products), /downtime_window_sufficient/);
});

test("反例：硬约束未过时推荐结论写成 proceed 被拒绝", async () => {
  const d = await setup();
  d.matchesDoc.matches.find((m) => m.product_id === "prod-cloud-aps").recommendation = "proceed";
  const { ent, products } = parseEntProducts(d);
  assert.throws(() => validateMatches(d.matchesDoc, ent, products), /不一致/);
});

test("反例：同一企业同一政策重复占用补贴被拒绝", async () => {
  const d = await setup();
  const { ent, products, matchResults } = validChain(d);
  const clone = structuredClone(d.engagementsDoc.engagements[0]);
  clone.engagement_id = "eng-010-vision-dup";
  clone.subsidy.occupancy = "reserved";
  clone.subsidy.reserved_at = "2026-05-10";
  d.engagementsDoc.engagements.push(clone);
  assert.throws(
    () => validateEngagements(d.engagementsDoc, ent, products, matchResults, d.catalog),
    /重复补贴占用/,
  );
});

test("反例：失败退出却不释放补贴被拒绝", async () => {
  const d = await setup();
  const { ent, products, matchResults } = validChain(d);
  const aps = d.engagementsDoc.engagements.find((e) => e.engagement_id === "eng-010-aps-dd");
  aps.subsidy = {
    program_id: "subsidy-dd-audit-2026",
    reserved_amount: 20000,
    currency: "CNY",
    reserved_at: "2026-04-10",
    occupancy: "reserved",
  };
  assert.throws(
    () => validateEngagements(d.engagementsDoc, ent, products, matchResults, d.catalog),
    /补贴占用必须释放/,
  );
});

test("反例：商业数据对服务商可见被拒绝", async () => {
  const d = await setup();
  const { ent, products, matchResults } = validChain(d);
  d.engagementsDoc.engagements[0].data_isolation.commercial_data_visible_to_provider = true;
  assert.throws(
    () => validateEngagements(d.engagementsDoc, ent, products, matchResults, d.catalog),
    /商业数据/,
  );
});

test("反例：证据不归企业或不可携带被拒绝", async () => {
  const d = await setup();
  const { ent, products, matchResults } = validChain(d);
  d.engagementsDoc.engagements[0].evidence_ownership.portable_on_switch = false;
  assert.throws(
    () => validateEngagements(d.engagementsDoc, ent, products, matchResults, d.catalog),
    /证据/,
  );
});

test("反例：状态声称已部署但没有部署记录被拒绝", async () => {
  const d = await setup();
  const { ent, products, matchResults } = validChain(d);
  const vision = d.engagementsDoc.engagements[0];
  vision.state = "deployed";
  vision.records = vision.records.filter((r) => r.kind !== "deployment");
  assert.throws(
    () => validateEngagements(d.engagementsDoc, ent, products, matchResults, d.catalog),
    /deployment/,
  );
});

test("反例：匹配结论为 reject 却签约被拒绝", async () => {
  const d = await setup();
  const { ent, products, matchResults } = validChain(d);
  const aps = d.engagementsDoc.engagements.find((e) => e.engagement_id === "eng-010-aps-dd");
  aps.state = "contracted";
  aps.records.push({
    record_id: "rec-aps-sign",
    kind: "signing",
    at: "2026-04-20",
    evidence_id: "ev-contract-a",
  });
  assert.throws(
    () => validateEngagements(d.engagementsDoc, ent, products, matchResults, d.catalog),
    /reject/,
  );
});

test("反例：读数相对基线的时间倒挂被拒绝", async () => {
  const d = await setup();
  const { ent, products, matchResults } = validChain(d);
  const reading = d.engagementsDoc.engagements[0].records.find(
    (r) => r.record_id === "rec-vision-reading-hours",
  );
  reading.at = "2026-01-01";
  assert.throws(
    () => validateEngagements(d.engagementsDoc, ent, products, matchResults, d.catalog),
    /基线测量时间|早于/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  parseJson,
  validateEnterprise,
  validateIndustry,
  validateProducts,
  validateMatching,
  validateEngagement,
  eventsByType,
  eventsByEngagement,
} from "../src/domain.js";

const load = (name) => readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8").then(parseJson);

let enterprise;
let industry;
let products;
let matching;
let engagement;

test.before(async () => {
  [enterprise, industry, products, matching, engagement] = await Promise.all([
    load("enterprise.json"),
    load("industry.json"),
    load("products.json"),
    load("matching.json"),
    load("engagement.json"),
  ]);
});

test("五份样例资料全部通过领域不变量校验", () => {
  assert.doesNotThrow(() => validateEnterprise(enterprise));
  assert.doesNotThrow(() => validateIndustry(industry));
  assert.doesNotThrow(() => validateProducts(products));
  assert.doesNotThrow(() => validateMatching(matching, enterprise, products));
  assert.doesNotThrow(() => validateEngagement(engagement, enterprise, products));
});

test("企业基线必须是企业实测且挂证据；行业均值不能冒充基线", () => {
  const tampered = structuredClone(enterprise);
  // 把目标的指标引用改成行业均值标识
  tampered.targets[0].metric_id = "bm-changeover";
  assert.throws(() => validateEnterprise(tampered), /必须引用本企业实测基线指标/);

  const noEvidence = structuredClone(enterprise);
  noEvidence.production_line.baseline.metrics[0].evidence_refs = [];
  assert.throws(() => validateEnterprise(noEvidence), /缺少证据引用/);
});

test("行业资料只能标记 comparison_only", () => {
  const tampered = structuredClone(industry);
  tampered.usage = "baseline_input";
  assert.throws(() => validateIndustry(tampered), /comparison_only/);
});

test("产品披露：唯一生效报价、硬性前提与能力边界缺一不可", () => {
  const twoActive = structuredClone(products);
  twoActive.providers[0].products[0].pricing_versions[1].status = "superseded";
  assert.throws(() => validateProducts(twoActive), /恰有一个生效报价/);

  const noBoundary = structuredClone(products);
  noBoundary.providers[0].products[0].capability_boundary.does_not = [];
  assert.throws(() => validateProducts(noBoundary), /does_not 不能为空/);
});

test("匹配结论：推荐项必须过窗口与预算，被拒项必须给出硬阻断", () => {
  const overBudget = structuredClone(matching);
  overBudget.recommendation.product_ref = "prod-pangu-mes";
  assert.throws(() => validateMatching(overBudget, enterprise, products), /推荐结论只能指向/);

  const rejectWithoutBlocker = structuredClone(matching);
  delete rejectWithoutBlocker.candidates[1].hard_blockers;
  assert.throws(() => validateMatching(rejectWithoutBlocker, enterprise, products), /必须列出硬性阻断项/);
});

test("预期效果引用行业均值或构成承诺时必须被拒", () => {
  const benchmarkBasis = structuredClone(matching);
  benchmarkBasis.expected_effects[0].baseline_ref = "bm-changeover";
  assert.throws(() => validateMatching(benchmarkBasis, enterprise, products), /不得引用行业均值/);

  const binding = structuredClone(matching);
  binding.expected_effects[0].binding = true;
  assert.throws(() => validateMatching(binding, enterprise, products), /binding 必须为 false/);
});

test("失败退出必须撤销数据授权、释放补贴并留存删除证据", () => {
  const grantKept = structuredClone(engagement);
  const failed = grantKept.engagements.find((e) => e.status === "terminated_failure_exit");
  failed.data_grants[0].status = "active";
  failed.data_grants[0].revoked_at = null;
  assert.throws(() => validateEngagement(grantKept, enterprise, products), /必须已撤销/);

  const subsidyKept = structuredClone(engagement);
  const failed2 = subsidyKept.engagements.find((e) => e.status === "terminated_failure_exit");
  failed2.subsidy_occupations[0].status = "partially_disbursed";
  failed2.subsidy_occupations[0].disbursed_cny = 10000;
  failed2.subsidy_occupations[0].released_at = null;
  assert.throws(() => validateEngagement(subsidyKept, enterprise, products), /失败退出后补贴必须释放/);

  const noDestroyProof = structuredClone(engagement);
  delete noDestroyProof.engagements[0].exit.data_destruction_evidence_ref;
  assert.throws(() => validateEngagement(noDestroyProof, enterprise, products), /数据删除证据/);
});

test("同一补贴同一时点不得被两个项目重复占用", () => {
  const overlap = structuredClone(engagement);
  overlap.engagements[1].subsidy_occupations[0].reserved_at = "2025-06-01";
  overlap.engagements[1].subsidy_occupations[0].released_at = null;
  assert.throws(() => validateEngagement(overlap, enterprise, products), /重复占用/);
});

test("账本必须按时间追加，指标变化必须同时记录基线值", () => {
  const unsorted = structuredClone(engagement);
  // 交换 2025-05-22 的授权事件与 2025-09-15 的证据登记事件
  [unsorted.ledger[2], unsorted.ledger[3]] = [unsorted.ledger[3], unsorted.ledger[2]];
  assert.throws(() => validateEngagement(unsorted, enterprise, products), /时序必须追加/);

  const noBaseline = structuredClone(engagement);
  noBaseline.ledger.find((e) => e.type === "metric_change").payload.baseline_value = null;
  assert.throws(() => validateEngagement(noBaseline, enterprise, products), /必须同时记录基线值/);
});

test("账本累计拨付必须与补贴占用记录一致", () => {
  const mismatch = structuredClone(engagement);
  mismatch.engagements[1].subsidy_occupations[0].disbursed_cny = 99999;
  assert.throws(() => validateEngagement(mismatch, enterprise, products), /账本累计拨付/);
});

test("更换服务商时保留的证据必须在企业自有证据仓中", () => {
  const stolen = structuredClone(engagement);
  stolen.provider_switch.evidence_retained_by_enterprise = ["ev-owned-by-provider"];
  assert.throws(() => validateEngagement(stolen, enterprise, products), /不在企业证据仓中/);
});

test("签约、部署、指标变化、持续使用分类型可查", () => {
  assert.equal(eventsByType(engagement, "contract_signed").length, 2);
  assert.equal(eventsByType(engagement, "deployed").length, 1);
  assert.ok(eventsByType(engagement, "metric_change").length >= 3);
  assert.ok(eventsByType(engagement, "sustained_use").length >= 6);
  const qyEvents = eventsByEngagement(engagement, "eng-qieyun-2026");
  const qyChangeovers = qyEvents.filter((e) => e.type === "metric_change" && e.payload.metric_ref === "m-changeover");
  assert.deepEqual(
    qyChangeovers.map((e) => e.payload.value),
    [96, 74, 57.5]
  );
  // 指标轨迹始终带着基线值 118，行业 85 分钟均值从未进入轨迹
  assert.ok(qyChangeovers.every((e) => e.payload.baseline_value === 118));
});

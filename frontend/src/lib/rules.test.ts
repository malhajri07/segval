import { describe as suite, expect, it } from "vitest";
import type { Catalog, RuleNode } from "../api/types";
import { countConditions, describe, fieldOptions, fmtCompact, newAttribute } from "./rules";

const catalog = {
  domain: "t", display: "T", currency: "SAR",
  anchors: [{ id: "subscription", entity: "subscription", display: "Subs", description: "", profile_dimensions: [], sample_fields: [] }],
  entities: [
    { id: "subscription", label: "Subscription", display: "Subscription", description: "", key: "msisdn",
      paths: { subscription: [] }, multi_valued: { subscription: false },
      attributes: [{ id: "status", property: "status", type: "enum", display: "Status", description: "", unit: null, values: ["ACTIVE", "CHURNED"], buckets: null, searchable: false }] },
    { id: "addon", label: "Addon", display: "Add-on", description: "", key: "addon_id",
      paths: { subscription: [{ rel: "HAS_ADDON", direction: "out", label: "Addon", many: true }] }, multi_valued: { subscription: true },
      attributes: [{ id: "category", property: "category", type: "enum", display: "Category", description: "", unit: null, values: ["Roaming"], buckets: null, searchable: false }] },
  ],
  metrics: [], networks: [{ id: "calls", display: "Call graph", description: "", anchor: "subscription", rel: "CALLED", direction: "both", edge_attributes: [] }],
  operators: { number: ["gt"], string: ["eq"], enum: ["eq", "in"], boolean: ["eq"], date: ["gt"] },
  metric_operators: ["gt"], count_operators: ["gte"],
} as unknown as Catalog;

suite("rules", () => {
  it("lists fields reachable from the anchor, flagging multi-valued ones", () => {
    const opts = fieldOptions(catalog, "subscription");
    expect(opts.map((o) => o.field)).toEqual(["subscription.status", "addon.category"]);
    expect(opts[1].multi).toBe(true);
    expect(fieldOptions(catalog, "subscription", "addon").map((o) => o.field)).toEqual(["addon.category"]);
  });

  it("creates attribute conditions with valid defaults", () => {
    expect(newAttribute(catalog, "subscription")).toEqual({
      kind: "attribute", field: "subscription.status", operator: "eq", value: "ACTIVE",
    });
  });

  it("describes a rule in plain language", () => {
    const rule: RuleNode = {
      kind: "group", op: "and", children: [
        { kind: "attribute", field: "subscription.status", operator: "eq", value: "ACTIVE" },
        { kind: "network", network: "calls", count_operator: "gte", count_value: 2, edge_where: [],
          where: { kind: "attribute", field: "subscription.status", operator: "eq", value: "CHURNED" } },
        { kind: "segment", segment_id: "s1", negate: true },
      ],
    };
    expect(describe(rule, catalog, { s1: "VIP" })).toBe(
      "(Subscription status is ACTIVE AND at least 2 contacts in Call graph who are Subscription status is CHURNED AND not in segment “VIP”)",
    );
    expect(countConditions(rule)).toBe(4);
  });

  it("formats compact numbers", () => {
    expect(fmtCompact(32018)).toBe("32.0k");
    expect(fmtCompact(0.2234)).toBe("0.22");
    expect(fmtCompact(null)).toBe("–");
  });
});

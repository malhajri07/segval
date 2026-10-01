/**
 * The browser engine must agree with the real backend. The fixture is produced by
 * compiling rules with the Python compiler and counting them in Neo4j over the
 * same synthetic dataset that data.json holds.
 */
import { describe, expect, it } from "vitest";
import type { SegmentDefinition } from "../api/types";
import { Compiler, CompileError, Graph, type Snapshot } from "./engine";
import data from "./data.json";
import fixture from "./parity.fixture.json";

const snap = data as unknown as Snapshot;
const keys: Record<string, string> = { MonthlyUsage: "usage_id" };
for (const e of snap.catalog.entities) keys[e.label] = e.key;
const graph = new Graph(snap, keys);
const compiler = new Compiler(snap.catalog, { asOf: fixture.as_of, members: () => undefined });

describe("parity with the Python compiler and Neo4j", () => {
  it("uses the same dataset snapshot", () => {
    expect(snap.as_of).toBe(fixture.as_of);
  });

  for (const c of fixture.cases) {
    it(`${c.id}: same Cypher, params and count`, () => {
      const cp = compiler.compile(c.definition as SegmentDefinition);
      expect(cp.predicate).toBe(c.predicate);
      expect(cp.params).toEqual(c.params);
      expect(graph.nodes(cp.label).filter(cp.test).length).toBe(c.count);
    });
  }

  for (const e of fixture.errors) {
    it(`${e.id}: same validation error`, () => {
      try {
        compiler.compile({ anchor: "subscription", rule: e.rule } as SegmentDefinition);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(CompileError);
        expect((err as CompileError).path).toBe(e.path);
        expect((err as CompileError).detail).toBe(e.message);
      }
    });
  }
});

describe("analytics parity (funnel and trend) with the backend", async () => {
  const { DemoService } = await import("./service");
  const svc = new DemoService(data as unknown as Snapshot);
  for (const a of fixture.analytics) {
    it(`${a.id}: funnel matches`, () => {
      expect(svc.funnel({ definition: a.definition as SegmentDefinition })).toEqual(a.funnel);
    });
    for (const [name, expected] of [["trend", a.trend], ["tickets", a.tickets]] as const) {
      it(`${a.id}: ${name} matches`, () => {
        const got = svc.trend({ definition: a.definition as SegmentDefinition, metric: expected.metric });
        expect(got.points.map((p) => p.month)).toEqual(expected.points.map((p) => p.month));
        got.points.forEach((p, i) => {
          const e = expected.points[i];
          expect(p.segment_n).toBe(e.segment_n);
          expect(p.base_n).toBe(e.base_n);
          for (const k of ["segment", "base"] as const) {
            if (e[k] === null) expect(p[k]).toBeNull();
            else expect(p[k]).toBeCloseTo(e[k] as number, 6);
          }
        });
      });
    }
  }
});

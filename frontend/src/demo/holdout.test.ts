import { expect, it } from "vitest";
import { fnv1a32, inControl } from "./holdout";

it("matches the FNV-1a reference vectors", () => {
  expect(fnv1a32("")).toBe(0x811c9dc5);
  expect(fnv1a32("a")).toBe(0xe40c292c);
  expect(fnv1a32("foobar")).toBe(0xbf9cf968);
});

it("assigns the same control members as the Python backend", () => {
  // Expected values printed by backend/segval/services/holdout.py.
  expect(fnv1a32("abc123:966500000007")).toBe(193667198);
  const keys = Array.from({ length: 12 }, (_, i) => `9665${String(i + 1).padStart(8, "0")}`);
  expect(keys.filter((k) => inControl("abc123", k, 25)))
    .toEqual(["966500000001", "966500000005", "966500000009", "966500000012"]);
});

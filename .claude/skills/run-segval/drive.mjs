// Drive SegVal in headless Chromium and screenshot each page.
// Usage: node .claude/skills/run-segval/drive.mjs [baseUrl] [outDir]
//   baseUrl defaults to http://localhost:5173; pass file:///…/frontend/dist-demo/index.html
//   to drive the offline demo build. Run it from a directory where `npm i playwright`
//   was done: Playwright is resolved from the current working directory.
import fs from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(`${process.cwd()}/`)("playwright");

const BASE = process.argv[2] ?? "http://localhost:5173";
const OUT = process.argv[3] ?? "/tmp/segval/shots";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const nav = (name) => page.getByRole("link", { name, exact: true }).click();

await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Segments", exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/1-segments.png` });

await nav("Builder");
await page.getByRole("button", { name: "+ Add condition" }).click();
await page.getByRole("menuitem", { name: /^Graph network/ }).click();
await page.locator(".hero-number").waitFor();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/2-builder.png` });
console.log("builder count:", await page.locator(".hero-number").textContent());

await nav("Graph");
await page.locator("g.node-Customer").nth(1).waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "Fit" }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/3-graph.png` });
console.log("graph nodes:", await page.locator("g.node").count());

await nav("Catalog");
await page.getByRole("heading", { name: "Data catalog" }).waitFor();
console.log("page errors:", errors.length ? errors : "none");
console.log("screenshots in", OUT);
await browser.close();
process.exit(errors.length ? 1 : 0);

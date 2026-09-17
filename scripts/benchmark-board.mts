/** Run with: node --import ./test/ts-resolve.mjs scripts/benchmark-board.mts
 * Synthetic contention calculation only, not browser frame measurements. */
import { performance } from "node:perf_hooks";
import { createBoardIndex } from "../lib/board-index.ts";
import type { Ticket } from "../lib/types.ts";

for (const count of [50, 100, 200, 400, 1000]) {
  const tickets: Ticket[] = Array.from({ length: count }, (_, i) => ({
    id: String(i), title: String(i), description: "", status: i % 5 === 0 ? "running" : "todo",
    files: [`src/${i % 20}.ts`, `src/${(i + 1) % 20}.ts`], log: [],
  }));
  const samples: number[] = [];
  for (let trial = 0; trial < 15; trial++) {
    const start = performance.now();
    createBoardIndex(tickets);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${count} tickets: ${samples[7].toFixed(3)} ms median`);
}

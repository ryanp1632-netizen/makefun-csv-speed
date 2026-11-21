// The program the harness runs (node /bot/main.ts, node22): reads every case from /input/cases.json, answers each with
// solve.js and writes /output/answers.json. answerCases reads the bytes of cases.json and writes the answers' JSON in one
// pass (run() answers any case it does not take); if the file is not in a shape it reads, every case is decoded and
// answered with run(). MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and /output outside a container.

import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags, set before solve.js is imported: incremental marking off (as the house driver runs) and background GC tasks
// off, as the sandbox has one CPU. (TurboFan stays on: the grader's Node 22 may have no Maglev, and without both
// optimizing tiers the byte loop would run in the interpreter.)
setFlagsFromString('--no-incremental-marking --single-threaded-gc');

const { run, answerCases, answerFile, warmUp } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
  answerCases: (bytes: Buffer, fd?: number) => Uint8Array | null;
  answerFile: (path: string, fd: number) => void;
  warmUp: () => void;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const inPath = join(INPUT_DIR, 'cases.json');
const outPath = join(OUTPUT_DIR, 'answers.json');
let done = false;
try {
  // cases.json read straight into WebAssembly memory, the records read by its SIMD loop (see solve.js)
  const fd = openSync(outPath, 'w');
  answerFile(inPath, fd);
  closeSync(fd);
  done = true;
} catch {}
if (!done) {
  try {
    warmUp(); // type feedback for every branch first (see solve.js)
    const bytes = readFileSync(inPath);
    const fd = openSync(outPath, 'w');
    answerCases(bytes, fd);
    closeSync(fd);
    done = true;
  } catch {}
}
if (!done) {
  const cases = JSON.parse(readFileSync(inPath, 'utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  writeFileSync(outPath, JSON.stringify(answers));
}
// Everything is written and closed: exit without tearing the heap down.
process.exit(0);

// The program the harness runs (node /bot/main.ts, node22): reads every case from /input/cases.json, answers each with
// solve.js and writes /output/answers.json. answerCases reads the bytes of cases.json and writes the answers' JSON in one
// pass (run() answers any case it does not take); if the file is not in a shape it reads, every case is decoded and
// answered with run(). MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and /output outside a container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags, set before solve.js is imported: incremental marking off (as the house driver runs), and no TurboFan: the
// work is one hot loop per case, and Maglev's code arrives sooner and costs less to compile than TurboFan's saves on a
// ~10 MB input. Background GC tasks off, as the sandbox has one CPU.
setFlagsFromString('--no-incremental-marking --no-turbofan --single-threaded-gc');

const { run, answerCases } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
  answerCases: (bytes: Buffer) => Uint8Array;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const bytes = readFileSync(join(INPUT_DIR, 'cases.json'));
let out: Uint8Array | string;
try {
  out = answerCases(bytes);
} catch {
  const cases = JSON.parse(bytes.toString('utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  out = JSON.stringify(answers);
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), out);

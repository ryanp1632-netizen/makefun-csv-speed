# makefun-csv-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/ryanp1632-netizen/makefun-csv-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/ryanp1632-netizen/makefun-csv-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0 (the [Read broken CSV files faster](https://make.fun/bounty/csv-reader-speed-01-run-20261121) bounty). `solve.js` exports `run(input)`, which returns exactly csv-reader's `{columns, rows, errors}` for every `{text, header}`, broken rows included (stray CRs, quote junk, unterminated quotes, short and long rows), and `answerCases(bytes)`, which `main.ts` uses: it reads the bytes of `cases.json` once and writes the bytes of `answers.json` directly. Each text is parsed as it sits inside its JSON string literal (CSV's comma, quote, CR and LF are `,`, `\"`, `` and `
` there), and every field is copied straight into the output, which is already a JSON string body, so no input string is decoded and no output string is built. Any case in a shape it does not expect is answered by `run()`. No dependencies.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z79n7aa6&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>

// A faster drop-in for csv-reader 1.0.0's readCsv: run(input) returns the same {columns, rows, errors} for every
// {text, header}. Same broken-row policy, read in one left-to-right pass over char codes, each field taken as a slice
// of the text instead of being built one character at a time.

import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Results of the field readers (kept in locals of the closure to avoid allocating an object per field).
  let ended = END;
  let added = 0;

  // Reads unquoted characters after `prefix` up to the next comma or line break; a CR not followed by LF is dropped
  // (stray_cr). Sets `ended` and `added` (characters kept).
  function readUnquoted(prefix) {
    let start = pos;
    let value = prefix;
    let kept = 0;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        kept += pos - start;
        value = start === pos ? value : value + text.slice(start, pos);
        pos += 1;
        ended = COMMA;
        added = kept;
        return value;
      }
      if (c === 10) {
        kept += pos - start;
        value = start === pos ? value : value + text.slice(start, pos);
        pos += 1;
        line += 1;
        ended = LINE_BREAK;
        added = kept;
        return value;
      }
      if (c === 13) {
        kept += pos - start;
        value = start === pos ? value : value + text.slice(start, pos);
        if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          ended = LINE_BREAK;
          added = kept;
          return value;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    kept += pos - start;
    value = start === pos ? value : value + text.slice(start, pos);
    ended = END;
    added = kept;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let start = pos;
    let closed = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (pos + 1 < n && text.charCodeAt(pos + 1) === 34) {
          value += text.slice(start, pos + 1);
          pos += 2;
          start = pos;
          continue;
        }
        if (start !== pos) value += text.slice(start, pos);
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        value += text.slice(start, pos) + '\n';
        line += 1;
        pos += pos + 1 < n && text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        start = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= n) {
      ended = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      ended = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    const v = readUnquoted(value);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return v;
  }

  while (true) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = pos < n && text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === COMMA);

    if (fields.length === 1 && !quoted && fields[0] === '') continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// ---------------------------------------------------------------------------------------------------------------------
// answerCases(bytes): the whole job in one pass over the bytes of cases.json. It returns the bytes of answers.json, the
// same JSON values JSON.stringify(cases.map((c) => run(c.input))) gives, without decoding the input or building any
// string: each case's text is read as it stands inside its JSON string literal (escapes and all), and each field is
// copied straight to the output, which is already a JSON string body. Only CSV's own characters matter to the reader
// (comma, quote, CR, LF), and inside a JSON string they are spelled `,`, `\"`, `\r` and `\n`; any other byte or escape
// is one opaque character copied as it is. A case in any shape this fast path does not expect (escaped keys, a text
// that is not a string, a \u escape spelling one of those four characters, ...) is answered by run() instead.
//
// The text comes before its header flag in cases.json, and the flag changes only where the first record goes (columns
// or rows[0]) and the row numbers of the errors. So the text is read first: the first record is written with a gap of
// spaces before it and after it, the errors are kept as numbers, and once the flag is read the gaps are filled in
// (JSON allows the spaces that are left) and the errors written with their row numbers.

const QT = 0x22; // a raw quote: the end of the JSON string that holds the text
const BS = 0x5c; // a backslash: an escape
const CM = 0x2c; // a comma
const SP = 0x20; // a space
const LN = 0x6e; // 'n' of \n
const LR = 0x72; // 'r' of \r
const LU = 0x75; // 'u' of \uXXXX

let B = null; // the input bytes
let N = 0;
let p = 0; // the next input byte (between the texts)
let O = null; // the output bytes
let o = 0;

// The current case's errors, 5 numbers each: code, line, the record's ordinal (records read before it), and for
// short_row its field count, for long_row the extra fields' bytes [from, to) in X.
let ER = new Int32Array(5 * 4096);
let nErr = 0;
let X = null;
let xl = 0;
let XBASE = 0; // where X's extra bytes start (0, or XB when X is WebAssembly memory)
let JX = null; // the JavaScript reader's own extra-bytes buffer and error records
let JER = ER;
let OBASE = 0; // where the output starts in O
let WOUT = null; // O when it is WebAssembly memory
let WER = null; // the error records in WebAssembly memory
const ERRCAP = 1 << 22;
const XCAP = 1 << 22;
let recLine = 1;
let recOrd = 0;

// The current case's layout, from answerText to finishCase.
let gapAt = 0; // the 24 bytes for the case's opening
let r0End = -1; // the 9 bytes after the first record (-1: no record)
let nRecords = 0;

const STRAY = 0;
const JUNK = 1;
const UNTERM = 2;
const SHORT = 3;
const LONG = 4;

const enc = (s) => Buffer.from(s, 'latin1');
const ERR_PREFIX = [
  enc('{"code":"stray_cr","line":'),
  enc('{"code":"quote_junk","line":'),
  enc('{"code":"unterminated_quote","line":'),
  enc('{"code":"short_row","line":'),
  enc('{"code":"long_row","line":'),
];
const S_ROW = enc(',"row":');
const S_NULL = enc('null');
const S_FIELDS = enc(',"fields":');
const S_EXTRA = enc(',"extra":[');
const S_COLS = enc('{"columns":'); // 11 bytes
const S_COLS_NULL_ROWS = enc('{"columns":null,"rows":['); // 24 bytes
const S_ROWS = enc(',"rows":['); // 9 bytes
const S_NULL_ROWS = enc('null,"rows":[');
const S_EMPTY_ROWS = enc('[],"rows":[');
const S_ERRS = enc('],"errors":[');
const TEXT_KEY = enc('"text":"');
const HEADER_KEY = enc(',"header":');

function growO(need) {
  if (o + need <= O.length) return;
  const nb = Buffer.allocUnsafe(Math.max(O.length * 2, o + need + 65536));
  O.copy(nb, 0, 0, o);
  O = nb;
}

function putO(s) {
  s.copy(O, o);
  o += s.length;
}

function intO(v) {
  if (v < 10) {
    O[o++] = 48 + v;
    return;
  }
  let len = 1;
  for (let t = v; t >= 10; t = (t / 10) | 0) len++;
  let i = o + len;
  o = i;
  do {
    O[--i] = 48 + (v % 10);
    v = (v / 10) | 0;
  } while (v > 0);
}

function pushErr(code, a, b) {
  if (5 * nErr + 5 > ER.length) {
    const na = new Int32Array(ER.length * 2);
    na.set(ER);
    ER = na;
    if (WER === null || ER !== WER) JER = na;
  }
  const i = 5 * nErr++;
  ER[i] = code;
  ER[i + 1] = recLine;
  ER[i + 2] = recOrd;
  ER[i + 3] = a;
  ER[i + 4] = b;
}

function hexAt(i) {
  let v = 0;
  for (let k = 0; k < 4; k++) {
    const c = B[i + k];
    let d;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    else return -1;
    v = (v << 4) | d;
  }
  return v;
}

// A \uXXXX escape at i that this fast path cannot copy as an opaque character: one spelling a comma, a quote, CR or
// LF (which the reader must see as themselves), or one that is not well formed.
function uSpecial(i) {
  const v = hexAt(i + 2);
  return v < 0 || v === 0x0a || v === 0x0d || v === 0x22 || v === 0x2c;
}

// The reader's position between records (readRecord keeps them in locals while it runs).
let RQ = 0; // the next input byte
let RLN = 1; // the line it is on
let RW = 0; // the next output byte
let RWIDTH = -1; // the first record's width (-1: none yet)
let RNREC = 0; // records read

// Reads the text whose JSON string body starts at ts, writing its records at o (the case's opening left as a gap).
// Returns the index of the string's closing quote, or -1 if it bailed out (a \u escape it cannot copy).
function answerText(ts) {
  const b = B;
  let q = ts;
  nErr = 0;
  r0End = -1;
  nRecords = 0;
  if (b[q] === 0xef && b[q + 1] === 0xbb && b[q + 2] === 0xbf) q += 3;
  else if (b[q] === BS && b[q + 1] === LU && hexAt(q + 2) === 0xfeff) q += 6;
  growO(64);
  gapAt = o;
  if (WX !== null && O === WOUT) {
    WX.err.value = ERRB;
    WX.x.value = XB;
    WX.r0.value = -1;
    const r = WX.text(q, o + 24, MEMEND, ERRB + ERRCAP, XB + XCAP, N);
    if (r >= 0) {
      o = WX.out.value;
      nRecords = WX.nrec.value;
      r0End = WX.r0.value;
      nErr = (WX.err.value - ERRB) / 20;
      ER = WER;
      X = WOUT;
      xl = WX.x.value;
      XBASE = XB;
      return r;
    }
  }
  // The JavaScript reader (no WebAssembly, or a case it handed back).
  ER = JER;
  X = JX;
  xl = 0;
  XBASE = 0;
  RQ = q;
  RLN = 1;
  RW = o + 24;
  RWIDTH = -1;
  RNREC = 0;
  for (;;) {
    const r = readRecord();
    if (r === 0) break;
    if (r < 0) return -1;
  }
  o = RW;
  nRecords = RNREC;
  return RQ;
}

// Reads the next record (and any blank lines before it): 1, or 0 at the end of the text, or -1 to bail out. A call per
// record, with every position in a local while it runs: V8 optimizes it as an ordinary hot function, with no need to
// replace a running loop's frame (on-stack replacement). The field loop and the scans run inline, and only the rare
// paths (an error, a \u escape, a bigger output buffer) call out.
function readRecord() {
  const b = B;
  let out = O;
  let q = RQ;
  let ln = RLN;
  let w = RW;
  const width = RWIDTH;
  const nRec = RNREC;
  for (;;) {
    // Lines with no characters are no records.
    for (;;) {
      if (b[q] === BS) {
        const x = b[q + 1];
        if (x === LN) {
          q += 2;
          ln++;
          continue;
        }
        if (x === LR && b[q + 2] === BS && b[q + 3] === LN) {
          q += 4;
          ln++;
          continue;
        }
      }
      break;
    }
    if (b[q] === QT) {
      RQ = q;
      RLN = ln;
      RW = w;
      return 0;
    }

    recLine = ln;
    recOrd = nRec;
    const need = 3 * (N - q) + 4 * (width > 0 ? width : 0) + 256;
    if (w + need > out.length) {
      o = w;
      growO(need);
      out = O;
    }
    const recO = w;
    if (nRec >= 2) out[w++] = CM;
    out[w++] = 0x5b;
    let count = 0;
    let cutO = -1;
    let quoted = false;
    let firstEmpty = false;
    let ended = END;
    for (;;) {
      if (count > 0) {
        if (count === width) cutO = w;
        out[w++] = CM;
      }
      out[w++] = QT;
      const fs = w;
      let unquoted = true; // an unquoted scan follows
      let junk = false; // that scan reads what follows a closing quote
      quoted = b[q] === BS && b[q + 1] === QT;
      if (quoted) {
        const openQ = q;
        const openLn = ln;
        q += 2;
        let closed = false;
        for (;;) {
          let c = b[q];
          while (c !== QT && c !== BS) {
            out[w++] = c;
            c = b[++q];
          }
          if (c === QT) break;
          {
            const x = b[q + 1];
            if (x === QT) {
              if (b[q + 2] === BS && b[q + 3] === QT) {
                out[w++] = BS;
                out[w++] = QT;
                q += 4;
                continue;
              }
              q += 2;
              closed = true;
              break;
            }
            if (x === LR) {
              out[w++] = BS;
              out[w++] = LN;
              ln++;
              q += 2;
              if (b[q] === BS && b[q + 1] === LN) q += 2;
              continue;
            }
            if (x === LN) {
              out[w++] = BS;
              out[w++] = LN;
              ln++;
              q += 2;
              continue;
            }
            if (x === LU) {
              if (uSpecial(q)) return -1;
              out[w] = BS;
              out[w + 1] = LU;
              out[w + 2] = b[q + 2];
              out[w + 3] = b[q + 3];
              out[w + 4] = b[q + 4];
              out[w + 5] = b[q + 5];
              w += 6;
              q += 6;
              continue;
            }
            out[w++] = BS;
            out[w++] = x;
            q += 2;
          }
        }
        if (!closed) {
          // The quote never closes: a literal character, and the text after it is read again as unquoted.
          q = openQ + 2;
          ln = openLn;
          w = fs;
          pushErr(UNTERM, 0, 0);
          out[w++] = BS;
          out[w++] = QT;
        } else {
          const c = b[q];
          if (c === QT) {
            unquoted = false;
            ended = END;
          } else if (c === CM) {
            q++;
            unquoted = false;
            ended = COMMA;
          } else if (c === BS && b[q + 1] === LN) {
            q += 2;
            ln++;
            unquoted = false;
            ended = LINE_BREAK;
          } else if (c === BS && b[q + 1] === LR && b[q + 2] === BS && b[q + 3] === LN) {
            q += 4;
            ln++;
            unquoted = false;
            ended = LINE_BREAK;
          } else {
            junk = true;
          }
        }
      }
      if (unquoted) {
        // Unquoted characters up to the next comma, line break or the end of the text; a CR not followed by LF is
        // dropped (stray_cr). Every character kept writes at least one byte, so w moved iff one was kept.
        const w0 = w;
        ended = END;
        for (;;) {
          let c = b[q];
          while (c !== CM && c !== QT && c !== BS) {
            out[w++] = c;
            c = b[++q];
          }
          if (c === CM) {
            q++;
            ended = COMMA;
            break;
          }
          if (c === QT) break;
          {
            const x = b[q + 1];
            if (x === LN) {
              q += 2;
              ln++;
              ended = LINE_BREAK;
              break;
            }
            if (x === LR) {
              if (b[q + 2] === BS && b[q + 3] === LN) {
                q += 4;
                ln++;
                ended = LINE_BREAK;
                break;
              }
              pushErr(STRAY, 0, 0);
              q += 2;
              continue;
            }
            if (x === LU) {
              if (uSpecial(q)) return -1;
              out[w] = BS;
              out[w + 1] = LU;
              out[w + 2] = b[q + 2];
              out[w + 3] = b[q + 3];
              out[w + 4] = b[q + 4];
              out[w + 5] = b[q + 5];
              w += 6;
              q += 6;
              continue;
            }
            out[w++] = BS;
            out[w++] = x;
            q += 2;
          }
        }
        if (junk && w > w0) pushErr(JUNK, 0, 0);
      }
      if (count === 0) firstEmpty = w === fs;
      out[w++] = QT;
      count++;
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is no record (its stray_cr errors stay).
    if (count === 1 && !quoted && firstEmpty) {
      w = recO;
      continue;
    }
    if (nRec === 0) {
      // The first record: columns or rows[0], so the 9 bytes after it wait for the header flag.
      out[w++] = 0x5d;
      r0End = w;
      w += 9;
      RQ = q;
      RLN = ln;
      RW = w;
      RWIDTH = count;
      RNREC = 1;
      return 1;
    }
    if (count < width) {
      pushErr(SHORT, count, 0);
      for (let k = count; k < width; k++) {
        out[w++] = CM;
        out[w++] = QT;
        out[w++] = QT;
      }
    } else if (count > width) {
      const len = w - (cutO + 1);
      if (xl + len > X.length) {
        const nx = Buffer.allocUnsafe(Math.max(X.length * 2, xl + len + 65536));
        X.copy(nx, 0, 0, xl);
        X = nx;
        JX = nx;
      }
      out.copy(X, xl, cutO + 1, w);
      pushErr(LONG, xl, xl + len);
      xl += len;
      w = cutO;
    }
    out[w++] = 0x5d;
    RQ = q;
    RLN = ln;
    RW = w;
    RNREC = nRec + 1;
    return 1;
  }
}

// Fills in the case answerText read, now that its header flag is known, and writes its errors.
function finishCase(header) {
  const g = gapAt;
  if (nRecords === 0) {
    o = g;
    growO(32);
    putO(S_COLS);
    putO(header ? S_EMPTY_ROWS : S_NULL_ROWS);
  } else if (header) {
    O.fill(SP, g, g + 13);
    S_COLS.copy(O, g + 13);
    S_ROWS.copy(O, r0End);
  } else {
    S_COLS_NULL_ROWS.copy(O, g);
    if (nRecords > 1) {
      O[r0End] = CM;
      O.fill(SP, r0End + 1, r0End + 9);
    } else {
      O.fill(SP, r0End, r0End + 9);
    }
  }
  growO(nErr * 100 + (xl - XBASE) + 64);
  putO(S_ERRS);
  for (let i = 0; i < nErr; i++) {
    const k = 5 * i;
    if (i > 0) O[o++] = CM;
    const code = ER[k];
    putO(ERR_PREFIX[code]);
    intO(ER[k + 1]);
    putO(S_ROW);
    const row = header ? ER[k + 2] - 1 : ER[k + 2];
    if (row < 0) putO(S_NULL);
    else intO(row);
    if (code === SHORT) {
      putO(S_FIELDS);
      intO(ER[k + 3]);
    } else if (code === LONG) {
      putO(S_EXTRA);
      X.copy(O, o, ER[k + 3], ER[k + 4]);
      o += ER[k + 4] - ER[k + 3];
      O[o++] = 0x5d;
    }
    O[o++] = 0x7d;
  }
  O[o++] = 0x5d;
  O[o++] = 0x7d;
}

// ---- the JSON around the texts ----

function isWs(c) {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

function skipWs() {
  while (p < N && isWs(B[p])) p++;
}

// The index of the quote that closes the JSON string whose body starts at i.
function strEnd(i) {
  for (;;) {
    const j = B.indexOf(QT, i);
    if (j < 0) throw new Error('unterminated JSON string');
    let k = j - 1;
    while (B[k] === BS) k--;
    if (((j - 1 - k) & 1) === 0) return j;
    i = j + 1;
  }
}

// Skips one JSON value at p.
function skipValue() {
  skipWs();
  const c = B[p];
  if (c === QT) {
    p = strEnd(p + 1) + 1;
    return;
  }
  if (c === 0x7b || c === 0x5b) {
    let depth = 0;
    for (;;) {
      const d = B[p];
      if (d === QT) {
        p = strEnd(p + 1) + 1;
        continue;
      }
      if (d === 0x7b || d === 0x5b) depth++;
      else if (d === 0x7d || d === 0x5d) {
        depth--;
        if (depth === 0) {
          p++;
          return;
        }
      }
      p++;
      if (p >= N) throw new Error('unterminated JSON value');
    }
  }
  while (p < N) {
    const d = B[p];
    if (d === CM || d === 0x7d || d === 0x5d || isWs(d)) break;
    p++;
  }
}

function expect(c) {
  skipWs();
  if (B[p] !== c) throw new Error('unexpected JSON at byte ' + p);
  p++;
}

function keyIs(ks, ke, word) {
  if (ke - ks !== word.length) return false;
  for (let i = 0; i < word.length; i++) if (B[ks + i] !== word.charCodeAt(i)) return false;
  return true;
}

// Whether the bytes at i spell `s` (a Buffer).
function bytesAt(i, s) {
  for (let k = 0; k < s.length; k++) if (B[i + k] !== s[k]) return false;
  return true;
}

// Answers the case input that is the JSON value at vs, leaving p after it.
function answerInput(vs) {
  const caseO = o;
  p = vs;
  skipWs();
  const os = p;
  // The generator's shape, {"text":"…","header":true|false}: the text is read first, up to its closing quote.
  if (B[os] === 0x7b && bytesAt(os + 1, TEXT_KEY)) {
    const te = answerText(os + 1 + TEXT_KEY.length);
    if (te >= 0) {
      let r = te + 1;
      let header = -1;
      if (B[r] === 0x7d) {
        header = 0;
      } else if (bytesAt(r, HEADER_KEY)) {
        r += HEADER_KEY.length;
        if (keyIs(r, r + 4, 'true')) {
          header = 1;
          r += 4;
        } else if (keyIs(r, r + 5, 'false')) {
          header = 0;
          r += 5;
        }
      }
      if (header >= 0 && B[r] === 0x7d) {
        finishCase(header === 1);
        p = r + 1;
        return;
      }
    }
    o = caseO;
  }
  // Any other object of a string "text" and, if any, a literal true or false "header".
  p = os;
  let ok = false;
  let ts = -1;
  let te = -1;
  let header = false;
  let sawHeader = false;
  if (B[p] === 0x7b) {
    p++;
    skipWs();
    ok = B[p] !== 0x7d;
    while (ok) {
      skipWs();
      if (B[p] !== QT) {
        ok = false;
        break;
      }
      const ks = p + 1;
      const ke = strEnd(ks);
      p = ke + 1;
      expect(0x3a);
      skipWs();
      for (let i = ks; i < ke; i++) if (B[i] === BS) ok = false;
      if (!ok) break;
      if (keyIs(ks, ke, 'text')) {
        if (ts >= 0 || B[p] !== QT) {
          ok = false;
          break;
        }
        ts = p + 1;
        te = strEnd(ts);
        p = te + 1;
      } else if (keyIs(ks, ke, 'header')) {
        if (sawHeader) {
          ok = false;
          break;
        }
        sawHeader = true;
        if (keyIs(p, p + 4, 'true')) {
          header = true;
          p += 4;
        } else if (keyIs(p, p + 5, 'false')) {
          header = false;
          p += 5;
        } else {
          ok = false;
          break;
        }
      } else {
        skipValue();
      }
      skipWs();
      if (B[p] === CM) {
        p++;
        continue;
      }
      if (B[p] === 0x7d) {
        p++;
        break;
      }
      ok = false;
    }
    if (ts < 0) ok = false;
  }
  if (ok) {
    const after = p;
    if (answerText(ts) === te) {
      finishCase(header);
      p = after;
      return;
    }
  }
  // Any other shape: decode this one input and answer it with run().
  o = caseO;
  p = os;
  skipValue();
  const s = JSON.stringify(run(JSON.parse(B.toString('utf8', os, p))));
  growO(Buffer.byteLength(s) + 16);
  o += O.write(s, o, 'utf8');
}

/**
 * The bytes of answers.json for the bytes of cases.json (a JSON array of {id, input}). Given a file descriptor `fd`,
 * it writes them there instead, one case at a time, reusing one output buffer (so the run touches little fresh memory),
 * and returns null.
 */
export function answerCases(bytes, fd = -1, mem = null) {
  B = bytes;
  N = bytes.length;
  p = 0;
  JX = Buffer.allocUnsafe(1 << 16);
  X = JX;
  if (mem !== null) {
    // WebAssembly memory (answerFile): the output goes to its last region.
    O = mem;
    OBASE = OUTB;
    WOUT = mem;
    WER = new Int32Array(mem.buffer, ERRB, ERRCAP >> 2);
  } else {
    O = Buffer.allocUnsafe(3 * N + (1 << 20));
    OBASE = 0;
    WOUT = null;
    WER = null;
  }
  o = OBASE;
  expect(0x5b);
  O[o++] = 0x5b;
  skipWs();
  if (B[p] === 0x5d) {
    p++;
  } else {
    let first = true;
    for (;;) {
      expect(0x7b);
      let answered = false;
      skipWs();
      if (B[p] !== 0x7d) {
        for (;;) {
          expect(QT);
          const ks = p;
          const ke = strEnd(p);
          p = ke + 1;
          expect(0x3a);
          for (let i = ks; i < ke; i++) if (B[i] === BS) throw new Error('escaped key');
          if (keyIs(ks, ke, 'input')) {
            if (answered) throw new Error('a case with two inputs');
            answered = true;
            if (!first) {
              growO(1);
              O[o++] = CM;
            }
            first = false;
            answerInput(p);
            if (fd >= 0) {
              writeSync(fd, O, OBASE, o - OBASE);
              o = OBASE;
            }
          } else {
            skipValue();
          }
          skipWs();
          if (B[p] === CM) {
            p++;
            continue;
          }
          break;
        }
      }
      expect(0x7d);
      if (!answered) throw new Error('a case with no input');
      skipWs();
      if (B[p] === CM) {
        p++;
        continue;
      }
      expect(0x5d);
      break;
    }
  }
  growO(1);
  O[o++] = 0x5d;
  let out = null;
  if (fd >= 0) writeSync(fd, O, OBASE, o - OBASE);
  else out = Buffer.from(O.subarray(OBASE, o));
  B = null;
  X = null;
  JX = null;
  O = null;
  WOUT = null;
  WER = null;
  return out;
}

// A few small texts that take every path of the reader (a BOM, doubled quotes, CR, LF and CRLF inside quotes, stray
// CRs, quote junk, short and long rows, blank and CR-only lines, escapes, an unterminated quote), with and without a
// header. Reading them first gives V8 type feedback for every branch before the real input, so the optimized loop it
// compiles while reading the first big text does not have to bail out and be compiled again at each rare branch.
function warmText(k) {
  let t = k === 0 ? '﻿' : '';
  t += 'a,b,c\r\n';
  for (let i = 0; i < 12; i++) {
    t += `${i},"q""x${i}",3\r\n"multi\r\nline","lone\rcr","lf\nin"\nx\ry,${i},3\n"j"unk,2,3\n"j"\r,2,3\n1,2\n`;
    t += `1,2,3,4,"5""x"\n\n\r\n\r\r\na\tb,é,東\nback\\slash,"q,uote",x"y\n"\u0001",\ud800,c\n"ok"\n1,2,3\r\n`;
  }
  return t + (k === 1 ? '"unterminated,x,y\ntail,a,b' : 'end,a,"b"');
}

/** Runs answerCases on the warm-up texts (its output is thrown away). */
export function warmUp() {
  const cases = [];
  for (let k = 0; k < 3; k++) cases.push({ id: `w-${k}`, input: { text: warmText(k), header: k !== 1 } });
  cases.push({ id: 'w-3', input: { text: '', header: true } });
  cases.push({ id: 'w-4', input: { text: 'x', header: false } });
  answerCases(Buffer.from(JSON.stringify(cases), 'utf8'));
}

// ---------------------------------------------------------------------------------------------------------------------
// The record loop again, as a WebAssembly function (built here from its bytes, so there is no binary in the repository
// and nothing to install). It is the same reader as readRecord, line for line, with one addition: runs of ordinary bytes
// are copied 16 at a time with SIMD (load 16 bytes, find the first comma, quote or backslash with three compares and a
// bitmask, store all 16, advance to it). WebAssembly needs no warm-up: it is compiled before it runs, so the first byte
// of the first case already goes through compiled code.
//
// Memory: [0, N) the input (cases.json, read straight into it) and 64 spare bytes, then the error records, then the long
// rows' extra fields, then the output. text(q, w, lim, errEnd, xEnd, n) reads one text from q (after any BOM) writing
// its records from w; it returns the index of the text's closing quote, -1 to hand the case to the JavaScript reader
// (a \u00XX escape), or -2 when a region is too small (the JavaScript reader takes the case too). It leaves the output's
// end, the first record's end, the record count, the error records' end and the extra bytes' end in its globals.

const W_OUT = 0; // globals
const W_R0 = 1;
const W_NREC = 2;
const W_ERR = 3;
const W_X = 4;

function wasmText() {
  const u = (n) => {
    const r = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n !== 0) b |= 0x80;
      r.push(b);
    } while (n !== 0);
    return r;
  };
  const s = (n) => {
    const r = [];
    for (;;) {
      const b = n & 0x7f;
      n >>= 7;
      if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
        r.push(b);
        return r;
      }
      r.push(b | 0x80);
    }
  };
  const I32 = 0x7f;
  const V128 = 0x7b;
  // locals: 0..5 params, then these
  const P_Q = 0, P_W = 1, P_LIM = 2, P_ERREND = 3, P_XEND = 4, P_N = 5;
  const names = ['q', 'w', 'ln', 'width', 'nrec', 'count', 'cut', 'quoted', 'firstEmpty', 'ended', 'fs', 'c', 'x',
    'unq', 'junk', 'w0', 'recO', 'openQ', 'openLn', 'closed', 'bits', 'e', 'xl', 'k', 'len', 'recLine', 'recOrd', 'n'];
  const L = {};
  names.forEach((nm, i) => (L[nm] = 6 + i));
  const VC = 6 + names.length; // v128 locals
  const VQ = VC + 1;
  const VB = VC + 2;
  const VV = VC + 3;

  const code = [];
  const op = (...b) => code.push(...b);
  const get = (i) => op(0x20, ...u(i));
  const set = (i) => op(0x21, ...u(i));
  const gset = (i) => op(0x24, ...u(i));
  const c32 = (v) => op(0x41, ...s(v));
  const add = () => op(0x6a);
  const sub = () => op(0x6b);
  const mul = () => op(0x6c);
  const eq = () => op(0x46);
  const ne = () => op(0x47);
  const and = () => op(0x71);
  const ltS = () => op(0x48);
  const gtS = () => op(0x4a);
  const geS = () => op(0x4e);
  const ld8 = (off = 0) => op(0x2d, 0x00, ...u(off));
  const st8 = (off = 0) => op(0x3a, 0x00, ...u(off));
  const st32 = (off = 0) => op(0x36, 0x02, ...u(off));
  const blk = () => op(0x02, 0x40);
  const lp = () => op(0x03, 0x40);
  const iff = () => op(0x04, 0x40);
  const els = () => op(0x05);
  const end = () => op(0x0b);
  const br = (d) => op(0x0c, ...u(d));
  const brIf = (d) => op(0x0d, ...u(d));
  const ret = () => op(0x0f);
  const inc = (i, by) => {
    get(i);
    c32(by);
    add();
    set(i);
  };
  // byte at local i + off
  const byteAt = (i, off) => {
    get(i);
    ld8(off);
  };
  // out[w + off] = v
  const put = (off, v) => {
    get(L.w);
    c32(v);
    st8(off);
  };
  const putLocal = (off, li) => {
    get(L.w);
    get(li);
    st8(off);
  };
  // pushErr(code, a from local or const, b)
  const pushErr = (codeNum, aLocal = -1, bLocal = -1) => {
    // if (e + 20 > errEnd) return -2
    get(L.e);
    c32(20);
    add();
    get(P_ERREND);
    gtS();
    iff();
    c32(-2);
    ret();
    end();
    get(L.e);
    c32(codeNum);
    st32(0);
    get(L.e);
    get(L.recLine);
    st32(4);
    get(L.e);
    get(L.recOrd);
    st32(8);
    get(L.e);
    if (aLocal >= 0) get(aLocal);
    else c32(0);
    st32(12);
    get(L.e);
    if (bLocal >= 0) get(bLocal);
    else c32(0);
    st32(16);
    inc(L.e, 20);
  };
  // SIMD run copy: while the 16 bytes at q hold none of the specials, copy them; then copy up to the first special.
  const simdRun = (withComma) => {
    lp(); // depth 0
    get(L.q);
    op(0xfd, 0x00, 0x00, 0x00); // v128.load align=0 offset=0
    set(VV);
    get(VV);
    get(VQ);
    op(0xfd, ...u(35)); // i8x16.eq
    get(VV);
    get(VB);
    op(0xfd, ...u(35));
    op(0xfd, ...u(80)); // v128.or
    if (withComma) {
      get(VV);
      get(VC);
      op(0xfd, ...u(35));
      op(0xfd, ...u(80));
    }
    op(0xfd, ...u(100)); // i8x16.bitmask
    set(L.bits);
    get(L.w);
    get(VV);
    op(0xfd, ...u(11), 0x00, 0x00); // v128.store
    get(L.bits);
    op(0x45); // i32.eqz
    iff();
    inc(L.q, 16);
    inc(L.w, 16);
    br(1);
    end();
    end();
    get(L.bits);
    op(0x68); // i32.ctz
    set(L.n);
    get(L.q);
    get(L.n);
    add();
    set(L.q);
    get(L.w);
    get(L.n);
    add();
    set(L.w);
  };
  // \u escape at q: return -1 for \u00XX, else copy the 6 bytes
  const uEscape = () => {
    byteAt(L.q, 2);
    c32(0x30);
    eq();
    byteAt(L.q, 3);
    c32(0x30);
    eq();
    and();
    iff();
    c32(-1);
    ret();
    end();
    for (let k = 0; k < 6; k++) {
      get(L.w);
      byteAt(L.q, k);
      st8(k);
    }
    inc(L.w, 6);
    inc(L.q, 6);
  };

  // ---- body ----
  get(P_Q);
  set(L.q);
  get(P_W);
  set(L.w);
  c32(1);
  set(L.ln);
  c32(-1);
  set(L.width);
  c32(0);
  set(L.nrec);
  op(0x23, ...u(W_ERR)); // e and xl start where JS put them (globals)
  set(L.e);
  op(0x23, ...u(W_X));
  set(L.xl);
  c32(0x2c);
  op(0xfd, ...u(15)); // i8x16.splat
  set(VC);
  c32(0x22);
  op(0xfd, ...u(15));
  set(VQ);
  c32(0x5c);
  op(0xfd, ...u(15));
  set(VB);

  blk(); // $done (depth for 'break out of records')
  lp(); // $R
  // blank lines
  lp(); // $BL
  byteAt(L.q, 0);
  c32(0x5c);
  eq();
  iff();
  byteAt(L.q, 1);
  set(L.x);
  get(L.x);
  c32(0x6e);
  eq();
  iff();
  inc(L.q, 2);
  inc(L.ln, 1);
  br(2); // to $BL
  end();
  get(L.x);
  c32(0x72);
  eq();
  byteAt(L.q, 2);
  c32(0x5c);
  eq();
  and();
  byteAt(L.q, 3);
  c32(0x6e);
  eq();
  and();
  iff();
  inc(L.q, 4);
  inc(L.ln, 1);
  br(2);
  end();
  end();
  end(); // $BL
  byteAt(L.q, 0);
  c32(0x22);
  eq();
  brIf(1); // to $done
  get(L.ln);
  set(L.recLine);
  get(L.nrec);
  set(L.recOrd);
  // room: lim - w < 3*(n - q) + 3*max(width,0) + 64 -> -2
  get(P_LIM);
  get(L.w);
  sub();
  get(P_N);
  get(L.q);
  sub();
  c32(3);
  mul();
  get(L.width);
  c32(0);
  get(L.width);
  c32(0);
  gtS();
  op(0x1b); // select(width, 0, width>0)
  c32(3);
  mul();
  add();
  c32(64);
  add();
  ltS();
  iff();
  c32(-2);
  ret();
  end();
  get(L.w);
  set(L.recO);
  get(L.nrec);
  c32(2);
  geS();
  iff();
  put(0, 0x2c);
  inc(L.w, 1);
  end();
  put(0, 0x5b);
  inc(L.w, 1);
  c32(0);
  set(L.count);
  c32(-1);
  set(L.cut);
  c32(0);
  set(L.firstEmpty);
  // fields
  lp(); // $F
  get(L.count);
  c32(0);
  gtS();
  iff();
  get(L.count);
  get(L.width);
  eq();
  iff();
  get(L.w);
  set(L.cut);
  end();
  put(0, 0x2c);
  inc(L.w, 1);
  end();
  put(0, 0x22);
  inc(L.w, 1);
  get(L.w);
  set(L.fs);
  c32(1);
  set(L.unq);
  c32(0);
  set(L.junk);
  byteAt(L.q, 0);
  c32(0x5c);
  eq();
  byteAt(L.q, 1);
  c32(0x22);
  eq();
  and();
  set(L.quoted);
  get(L.quoted);
  iff(); // quoted
  get(L.q);
  set(L.openQ);
  get(L.ln);
  set(L.openLn);
  inc(L.q, 2);
  c32(0);
  set(L.closed);
  blk(); // $qdone
  lp(); // $ql
  simdRun(false);
  byteAt(L.q, 0);
  c32(0x22);
  eq();
  brIf(1); // unclosed: end of text
  byteAt(L.q, 1);
  set(L.x);
  get(L.x);
  c32(0x22);
  eq();
  iff();
  byteAt(L.q, 2);
  c32(0x5c);
  eq();
  byteAt(L.q, 3);
  c32(0x22);
  eq();
  and();
  iff();
  put(0, 0x5c);
  put(1, 0x22);
  inc(L.w, 2);
  inc(L.q, 4);
  br(2); // $ql
  end();
  inc(L.q, 2);
  c32(1);
  set(L.closed);
  br(2); // $qdone (if depth 1, $ql 2, $qdone... ) -- see note below
  end();
  get(L.x);
  c32(0x72);
  eq();
  iff();
  put(0, 0x5c);
  put(1, 0x6e);
  inc(L.w, 2);
  inc(L.ln, 1);
  inc(L.q, 2);
  byteAt(L.q, 0);
  c32(0x5c);
  eq();
  byteAt(L.q, 1);
  c32(0x6e);
  eq();
  and();
  iff();
  inc(L.q, 2);
  end();
  br(1); // $ql
  end();
  get(L.x);
  c32(0x6e);
  eq();
  iff();
  put(0, 0x5c);
  put(1, 0x6e);
  inc(L.w, 2);
  inc(L.ln, 1);
  inc(L.q, 2);
  br(1);
  end();
  get(L.x);
  c32(0x75);
  eq();
  iff();
  uEscape();
  br(1);
  end();
  put(0, 0x5c);
  putLocal(1, L.x);
  inc(L.w, 2);
  inc(L.q, 2);
  br(0); // $ql
  end(); // $ql
  end(); // $qdone
  get(L.closed);
  op(0x45);
  iff(); // unclosed
  get(L.openQ);
  c32(2);
  add();
  set(L.q);
  get(L.openLn);
  set(L.ln);
  get(L.fs);
  set(L.w);
  pushErr(UNTERM);
  put(0, 0x5c);
  put(1, 0x22);
  inc(L.w, 2);
  els(); // closed: what follows the closing quote
  byteAt(L.q, 0);
  set(L.c);
  get(L.c);
  c32(0x22);
  eq();
  iff();
  c32(0);
  set(L.unq);
  c32(END);
  set(L.ended);
  els();
  get(L.c);
  c32(0x2c);
  eq();
  iff();
  inc(L.q, 1);
  c32(0);
  set(L.unq);
  c32(COMMA);
  set(L.ended);
  els();
  get(L.c);
  c32(0x5c);
  eq();
  byteAt(L.q, 1);
  c32(0x6e);
  eq();
  and();
  iff();
  inc(L.q, 2);
  inc(L.ln, 1);
  c32(0);
  set(L.unq);
  c32(LINE_BREAK);
  set(L.ended);
  els();
  get(L.c);
  c32(0x5c);
  eq();
  byteAt(L.q, 1);
  c32(0x72);
  eq();
  and();
  byteAt(L.q, 2);
  c32(0x5c);
  eq();
  and();
  byteAt(L.q, 3);
  c32(0x6e);
  eq();
  and();
  iff();
  inc(L.q, 4);
  inc(L.ln, 1);
  c32(0);
  set(L.unq);
  c32(LINE_BREAK);
  set(L.ended);
  els();
  c32(1);
  set(L.junk);
  end();
  end();
  end();
  end();
  end(); // unclosed/closed
  end(); // quoted
  get(L.unq);
  iff(); // unquoted scan
  get(L.w);
  set(L.w0);
  c32(END);
  set(L.ended);
  blk(); // $udone
  lp(); // $ul
  simdRun(true);
  byteAt(L.q, 0);
  set(L.c);
  get(L.c);
  c32(0x2c);
  eq();
  iff();
  inc(L.q, 1);
  c32(COMMA);
  set(L.ended);
  br(2); // $udone
  end();
  get(L.c);
  c32(0x22);
  eq();
  brIf(1); // $udone
  byteAt(L.q, 1);
  set(L.x);
  get(L.x);
  c32(0x6e);
  eq();
  iff();
  inc(L.q, 2);
  inc(L.ln, 1);
  c32(LINE_BREAK);
  set(L.ended);
  br(2);
  end();
  get(L.x);
  c32(0x72);
  eq();
  iff();
  byteAt(L.q, 2);
  c32(0x5c);
  eq();
  byteAt(L.q, 3);
  c32(0x6e);
  eq();
  and();
  iff();
  inc(L.q, 4);
  inc(L.ln, 1);
  c32(LINE_BREAK);
  set(L.ended);
  br(3); // $udone
  end();
  pushErr(STRAY);
  inc(L.q, 2);
  br(1); // $ul
  end();
  get(L.x);
  c32(0x75);
  eq();
  iff();
  uEscape();
  br(1);
  end();
  put(0, 0x5c);
  putLocal(1, L.x);
  inc(L.w, 2);
  inc(L.q, 2);
  br(0);
  end(); // $ul
  end(); // $udone
  get(L.junk);
  get(L.w);
  get(L.w0);
  gtS();
  and();
  iff();
  pushErr(JUNK);
  end();
  end(); // unquoted scan
  get(L.count);
  op(0x45);
  iff();
  get(L.w);
  get(L.fs);
  eq();
  set(L.firstEmpty);
  end();
  put(0, 0x22);
  inc(L.w, 1);
  inc(L.count, 1);
  get(L.ended);
  c32(COMMA);
  eq();
  brIf(0); // $F
  end(); // $F
  // a line of stray CRs only: no record
  get(L.count);
  c32(1);
  eq();
  get(L.quoted);
  op(0x45);
  and();
  get(L.firstEmpty);
  and();
  iff();
  get(L.recO);
  set(L.w);
  br(1); // $R
  end();
  get(L.nrec);
  op(0x45);
  iff(); // first record
  put(0, 0x5d);
  inc(L.w, 1);
  get(L.w);
  gset(W_R0);
  inc(L.w, 9);
  get(L.count);
  set(L.width);
  c32(1);
  set(L.nrec);
  br(1); // $R
  end();
  get(L.count);
  get(L.width);
  ltS();
  iff(); // short
  pushErr(SHORT, L.count);
  get(L.count);
  set(L.k);
  blk();
  lp();
  get(L.k);
  get(L.width);
  geS();
  brIf(1);
  put(0, 0x2c);
  put(1, 0x22);
  put(2, 0x22);
  inc(L.w, 3);
  inc(L.k, 1);
  br(0);
  end();
  end();
  els();
  get(L.count);
  get(L.width);
  gtS();
  iff(); // long
  get(L.w);
  get(L.cut);
  c32(1);
  add();
  sub();
  set(L.len);
  get(L.xl);
  get(L.len);
  add();
  get(P_XEND);
  gtS();
  iff();
  c32(-2);
  ret();
  end();
  get(L.xl);
  get(L.cut);
  c32(1);
  add();
  get(L.len);
  op(0xfc, ...u(10), 0x00, 0x00); // memory.copy
  get(L.xl);
  get(L.xl);
  get(L.len);
  add();
  set(L.k);
  set(L.n);
  pushErr(LONG, L.n, L.k);
  get(L.k);
  set(L.xl);
  get(L.cut);
  set(L.w);
  end();
  end();
  put(0, 0x5d);
  inc(L.w, 1);
  inc(L.nrec, 1);
  br(0); // $R
  end(); // $R
  end(); // $done
  get(L.w);
  gset(W_OUT);
  get(L.nrec);
  gset(W_NREC);
  get(L.e);
  gset(W_ERR);
  get(L.xl);
  gset(W_X);
  get(L.q);
  end(); // function

  // ---- module ----
  const vec = (items) => [...u(items.length), ...items.flat()];
  const section = (id, bytes) => [id, ...u(bytes.length), ...bytes];
  const str = (t) => [...u(t.length), ...Buffer.from(t, 'latin1')];
  const typeSec = section(1, vec([[0x60, ...vec([I32, I32, I32, I32, I32, I32]), ...vec([I32])]]));
  const importSec = section(2, vec([[...str('env'), ...str('mem'), 0x02, 0x00, ...u(1)]]));
  const funcSec = section(3, vec([[0x00]]));
  const globalSec = section(6, vec([0, 1, 2, 3, 4].map(() => [I32, 0x01, 0x41, 0x00, 0x0b])));
  const exportSec = section(
    7,
    vec([[...str('text'), 0x00, 0x00], ...['out', 'r0', 'nrec', 'err', 'x'].map((nm, i) => [...str(nm), 0x03, i])]),
  );
  const locals = vec([
    [...u(names.length), I32],
    [...u(4), V128],
  ]);
  const body = [...locals, ...code];
  const codeSec = section(10, vec([[...u(body.length), ...body]]));
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...typeSec, ...importSec, ...funcSec,
    ...globalSec, ...exportSec, ...codeSec]);
}

let WX = null; // the instance's exports, while answerCases reads from WebAssembly memory
let WMEM = null;
let ERRB = 0; // where the error records start in memory
let XB = 0; // where the extra fields start
let OUTB = 0; // where the output starts
let MEMEND = 0;

/**
 * Reads cases.json at `path` straight into WebAssembly memory and writes answers.json to `fd`, using the WebAssembly
 * record loop (and the JavaScript reader for any case it hands back). Throws if WebAssembly SIMD is not available.
 */
export function answerFile(path, fd) {
  const inFd = openSync(path, 'r');
  const n = fstatSync(inFd).size;
  const errCap = 1 << 22;
  const xCap = 1 << 22;
  const outCap = 3 * n + (1 << 20);
  const align = (v) => (v + 15) & ~15;
  ERRB = align(n + 64);
  XB = ERRB + errCap;
  OUTB = XB + xCap;
  MEMEND = OUTB + outCap;
  const mem = new WebAssembly.Memory({ initial: Math.ceil(MEMEND / 65536) + 1 });
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmText()), { env: { mem } });
  WX = inst.exports;
  WMEM = mem;
  const all = Buffer.from(mem.buffer);
  let got = 0;
  while (got < n) {
    const r = readSync(inFd, all, got, n - got, got);
    if (r <= 0) break;
    got += r;
  }
  closeSync(inFd);
  all.fill(0x20, n, n + 64);
  try {
    answerCases(all.subarray(0, n), fd, all);
  } finally {
    WX = null;
    WMEM = null;
  }
}

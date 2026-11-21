// A faster drop-in for csv-reader 1.0.0's readCsv: run(input) returns the same {columns, rows, errors} for every
// {text, header}. Same broken-row policy, read in one left-to-right pass over char codes, each field taken as a slice
// of the text instead of being built one character at a time.

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

const QT = 0x22; // a raw quote: the end of the JSON string that holds the text
const BS = 0x5c; // a backslash: an escape
const CM = 0x2c; // a comma
const LN = 0x6e; // 'n' of \n
const LR = 0x72; // 'r' of \r
const LU = 0x75; // 'u' of \uXXXX

let B = null; // the input bytes
let N = 0;
let p = 0; // the next input byte
let O = null; // the output bytes
let o = 0;
let E = null; // the current case's errors (the body of its errors array)
let e = 0;
let errCount = 0;
let recLine = 1;
let recRow = -1; // -1: the header (null)

const enc = (s) => Buffer.from(s, 'latin1');
const ERR_STRAY = enc('{"code":"stray_cr","line":');
const ERR_JUNK = enc('{"code":"quote_junk","line":');
const ERR_UNTERM = enc('{"code":"unterminated_quote","line":');
const ERR_SHORT = enc('{"code":"short_row","line":');
const ERR_LONG = enc('{"code":"long_row","line":');
const S_ROW = enc(',"row":');
const S_NULL = enc('null');
const S_FIELDS = enc(',"fields":');
const S_EXTRA = enc(',"extra":[');
const S_COLS = enc('{"columns":');
const S_NULL_ROWS = enc('null,"rows":[');
const S_ROWS = enc(',"rows":[');
const S_EMPTY_ROWS = enc('[],"rows":[');
const S_ERRS = enc('],"errors":[');

function growO(need) {
  if (o + need <= O.length) return;
  const nb = Buffer.allocUnsafe(Math.max(O.length * 2, o + need + 65536));
  O.copy(nb, 0, 0, o);
  O = nb;
}

function growE(need) {
  if (e + need <= E.length) return;
  const nb = Buffer.allocUnsafe(Math.max(E.length * 2, e + need + 65536));
  E.copy(nb, 0, 0, e);
  E = nb;
}

function putE(s) {
  s.copy(E, e);
  e += s.length;
}

function intE(v) {
  if (v < 10) {
    E[e++] = 48 + v;
    return;
  }
  let len = 1;
  for (let t = v; t >= 10; t = (t / 10) | 0) len++;
  let i = e + len;
  e = i;
  do {
    E[--i] = 48 + (v % 10);
    v = (v / 10) | 0;
  } while (v > 0);
}

// Opens an error record of `prefix` for the current record: {"code":…,"line":L,"row":R (left open for extra keys).
function openErr(prefix) {
  growE(96);
  if (errCount++ > 0) E[e++] = CM;
  putE(prefix);
  intE(recLine);
  putE(S_ROW);
  if (recRow < 0) putE(S_NULL);
  else intE(recRow);
}

function simpleErr(prefix) {
  openErr(prefix);
  E[e++] = 0x7d;
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

function putO(s) {
  s.copy(O, o);
  o += s.length;
}

// Answers one case whose text is the JSON string body starting at ts (its closing quote at te). False: bailed out.
// One function with every position in a local: the record loop, the field loop and the scans run inline, and only
// the rare paths (an error record, a \u escape, a bigger output buffer) call out.
function answerText(ts, te, header) {
  const b = B;
  let out = O;
  let q = ts; // the next input byte
  let w = o; // the next output byte
  let ln = 1; // the line q is on
  e = 0;
  errCount = 0;
  if (b[q] === 0xef && b[q + 1] === 0xbb && b[q + 2] === 0xbf) q += 3;
  else if (b[q] === BS && b[q + 1] === LU && hexAt(q + 2) === 0xfeff) q += 6;
  o = w;
  growO(64);
  out = O;
  S_COLS.copy(out, w);
  w += S_COLS.length;
  if (!header) {
    S_NULL_ROWS.copy(out, w);
    w += S_NULL_ROWS.length;
  }
  let haveCols = !header;
  let width = -1;
  let rowCount = 0;
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
      if (q !== te) return false; // te was a guess, and not this string's end
      break;
    }

    recLine = ln;
    const isHeader = !haveCols;
    recRow = isHeader ? -1 : rowCount;
    const need = 3 * (te - q) + 4 * (width > 0 ? width : 0) + 256;
    if (w + need > out.length) {
      o = w;
      growO(need);
      out = O;
    }
    const recO = w;
    if (!isHeader && rowCount > 0) out[w++] = CM;
    out[w++] = 0x5b;
    let count = 0;
    let cutO = -1;
    let quoted = false;
    let firstEmpty = false;
    let ended = END;
    for (;;) {
      if (count > 0) {
        if (count === width && !isHeader) cutO = w;
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
          const c = b[q];
          if (c === QT) break;
          if (c === BS) {
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
              if (uSpecial(q)) return false;
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
            continue;
          }
          out[w++] = c;
          q++;
        }
        if (!closed) {
          // The quote never closes: a literal character, and the text after it is read again as unquoted.
          q = openQ + 2;
          ln = openLn;
          w = fs;
          simpleErr(ERR_UNTERM);
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
          const c = b[q];
          if (c === CM) {
            q++;
            ended = COMMA;
            break;
          }
          if (c === QT) break;
          if (c === BS) {
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
              simpleErr(ERR_STRAY);
              q += 2;
              continue;
            }
            if (x === LU) {
              if (uSpecial(q)) return false;
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
            continue;
          }
          out[w++] = c;
          q++;
        }
        if (junk && w > w0) simpleErr(ERR_JUNK);
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
    if (width < 0) width = count;
    if (isHeader) {
      out[w++] = 0x5d;
      S_ROWS.copy(out, w);
      w += S_ROWS.length;
      haveCols = true;
      continue;
    }
    if (count < width) {
      openErr(ERR_SHORT);
      putE(S_FIELDS);
      intE(count);
      E[e++] = 0x7d;
      for (let k = count; k < width; k++) {
        out[w++] = CM;
        out[w++] = QT;
        out[w++] = QT;
      }
    } else if (count > width) {
      openErr(ERR_LONG);
      const len = w - (cutO + 1);
      growE(len + 16);
      putE(S_EXTRA);
      out.copy(E, e, cutO + 1, w);
      e += len;
      E[e++] = 0x5d;
      E[e++] = 0x7d;
      w = cutO;
    }
    out[w++] = 0x5d;
    rowCount++;
  }
  o = w;
  growO(e + 64);
  if (!haveCols) putO(S_EMPTY_ROWS);
  putO(S_ERRS);
  E.copy(O, o, 0, e);
  o += e;
  O[o++] = 0x5d;
  O[o++] = 0x7d;
  return true;
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

const NEEDLE = enc(',"header":');
const TEXT_KEY = enc('"text":"');

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
  // The generator's shape, {"text":"…","header":true|false}: the text's closing quote is found with one search. Inside
  // a JSON string every quote is escaped, so a `,"header":` there would be followed by a bare word, never valid JSON:
  // the first one after the text's opening quote lies outside it, and the text ends just before it when it is the
  // next key. answerText checks that guess at the string's real end and bails out if it was wrong.
  if (B[os] === 0x7b && bytesAt(os + 1, TEXT_KEY)) {
    const ts = os + 1 + TEXT_KEY.length;
    const j = B.indexOf(NEEDLE, ts);
    if (j > 0 && B[j - 1] === QT) {
      let r = j + NEEDLE.length;
      let header = -1;
      if (keyIs(r, r + 4, 'true')) {
        header = 1;
        r += 4;
      } else if (keyIs(r, r + 5, 'false')) {
        header = 0;
        r += 5;
      }
      if (header >= 0 && B[r] === 0x7d) {
        if (answerText(ts, j - 1, header === 1)) {
          p = r + 1;
          return;
        }
        o = caseO;
      }
    }
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
    if (answerText(ts, te, header)) {
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

/** The bytes of answers.json for the bytes of cases.json (a JSON array of {id, input}). */
export function answerCases(bytes) {
  B = bytes;
  N = bytes.length;
  p = 0;
  O = Buffer.allocUnsafe(3 * N + (1 << 20));
  o = 0;
  E = Buffer.allocUnsafe(1 << 20);
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
  const out = O.subarray(0, o);
  B = null;
  E = null;
  return out;
}

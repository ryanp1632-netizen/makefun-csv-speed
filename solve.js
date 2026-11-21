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

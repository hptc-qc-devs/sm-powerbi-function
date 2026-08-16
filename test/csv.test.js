const test = require('node:test');
const assert = require('node:assert/strict');

const { toCsv, escapeField, neutralizeFormula, BOM } = require('../src/lib/csv');

const stripBom = (text) => (text.startsWith(BOM) ? text.slice(BOM.length) : text);
const lines = (csv) => stripBom(csv).trimEnd().split('\r\n');

test('writes a header row from the column list, in order', () => {
  const csv = toCsv([{ b: 2, a: 1 }], ['a', 'b']);
  assert.equal(lines(csv)[0], 'a,b');
  assert.equal(lines(csv)[1], '1,2');
});

test('only the declared columns are emitted, and missing ones are blank', () => {
  const csv = toCsv([{ a: 1, ignored: 'x' }], ['a', 'b']);
  assert.equal(lines(csv)[1], '1,');
});

test('quotes fields containing commas, quotes or newlines', () => {
  const rows = [{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'line1\nline2' }];
  const out = lines(toCsv(rows, ['v']));

  assert.equal(out[1], '"a,b"');
  assert.equal(out[2], '"say ""hi"""');
  // A quoted field may legitimately span lines.
  assert.equal(out.slice(3).join('\r\n'), '"line1\nline2"');
});

test('null and undefined become empty fields, not the string "null"', () => {
  const csv = toCsv([{ a: null, b: undefined, c: '' }], ['a', 'b', 'c']);
  assert.equal(lines(csv)[1], ',,');
});

test('zero and false survive as values rather than being treated as empty', () => {
  const csv = toCsv([{ n: 0, b: false }], ['n', 'b']);
  assert.equal(lines(csv)[1], '0,FALSE');
});

test('booleans are written as TRUE/FALSE for Power BI to read as logical', () => {
  const csv = toCsv([{ b: true }], ['b']);
  assert.equal(lines(csv)[1], 'TRUE');
});

test('non-finite numbers become empty rather than "NaN" or "Infinity"', () => {
  const csv = toCsv([{ a: NaN, b: Infinity }], ['a', 'b']);
  assert.equal(lines(csv)[1], ',');
});

test('a UTF-8 BOM is written by default and can be turned off', () => {
  assert.ok(toCsv([{ a: 1 }], ['a']).startsWith(BOM));
  assert.ok(!toCsv([{ a: 1 }], ['a'], { bom: false }).startsWith(BOM));
});

test('output ends with a trailing newline', () => {
  assert.ok(toCsv([{ a: 1 }], ['a']).endsWith('\r\n'));
});

test('a header-only file is produced for an empty row set', () => {
  const csv = toCsv([], ['a', 'b']);
  assert.equal(lines(csv).length, 1);
  assert.equal(lines(csv)[0], 'a,b');
});

test('non-ASCII survey text passes through intact', () => {
  const csv = toCsv([{ v: 'Café — 日本語' }], ['v']);
  assert.ok(csv.includes('Café — 日本語'));
});

// --- formula injection -----------------------------------------------------

test('respondent text starting with = is neutralized before export', () => {
  // Without this, opening the export in Excel executes the formula.
  const csv = toCsv([{ v: '=SUM(A1:A9)' }], ['v']);
  assert.equal(lines(csv)[1], "'=SUM(A1:A9)");
});

test('all four spreadsheet formula prefixes are handled', () => {
  for (const dangerous of ['=cmd', '+cmd', '@SUM(1)', '-cmd']) {
    assert.equal(neutralizeFormula(dangerous), `'${dangerous}`);
  }
});

test('legitimate negative numbers are not mangled by the formula guard', () => {
  assert.equal(neutralizeFormula('-5'), '-5');
  assert.equal(neutralizeFormula('-12.5'), '-12.5');
  assert.equal(escapeField(-5, true), '-5');
});

test('the formula guard can be disabled explicitly', () => {
  const csv = toCsv([{ v: '=SUM(A1:A9)' }], ['v'], { sanitizeFormulas: false });
  assert.equal(lines(csv)[1], '=SUM(A1:A9)');
});

test('ordinary text is left completely alone', () => {
  assert.equal(neutralizeFormula('Great product'), 'Great product');
  assert.equal(neutralizeFormula(''), '');
});

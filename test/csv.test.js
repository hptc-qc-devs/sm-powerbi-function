const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toCsv,
  fromCsv,
  escapeField,
  neutralizeFormula,
  denormalizeFormula,
  BOM,
} = require('../src/lib/csv');

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

// --- parsing ---------------------------------------------------------------

test('parses a simple table into objects keyed by header', () => {
  const rows = fromCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [{ a: '1', b: '2' }]);
});

test('parses quoted fields containing commas, quotes and newlines', () => {
  const csv = 'v\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n';
  const rows = fromCsv(csv);

  assert.equal(rows[0].v, 'a,b');
  assert.equal(rows[1].v, 'say "hi"');
  assert.equal(rows[2].v, 'line1\nline2');
});

test('a leading BOM is not absorbed into the first column name', () => {
  const rows = fromCsv(`${BOM}a,b\r\n1,2\r\n`);
  assert.deepEqual(Object.keys(rows[0]), ['a', 'b']);
});

test('empty fields parse as null so blanks stay distinguishable', () => {
  const rows = fromCsv('a,b,c\r\n1,,3\r\n');
  assert.equal(rows[0].b, null);
});

test('a header-only file parses to no rows', () => {
  assert.deepEqual(fromCsv('a,b\r\n'), []);
  assert.deepEqual(fromCsv(''), []);
});

test('a trailing newline does not create a phantom empty row', () => {
  assert.equal(fromCsv('a\r\n1\r\n').length, 1);
  assert.equal(fromCsv('a\n1\n').length, 1);
});

test('LF-only line endings parse the same as CRLF', () => {
  assert.deepEqual(fromCsv('a,b\n1,2\n'), fromCsv('a,b\r\n1,2\r\n'));
});

test('a quoted empty field is a real row, not a phantom', () => {
  const rows = fromCsv('a\r\n""\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].a, null);
});

test('declared columns are coerced to numbers and booleans', () => {
  const rows = fromCsv('n,b,s\r\n4,TRUE,hello\r\n', {
    types: { n: 'number', b: 'boolean' },
  });

  assert.equal(rows[0].n, 4);
  assert.equal(rows[0].b, true);
  assert.equal(rows[0].s, 'hello', 'undeclared columns stay strings');
});

test('undeclared numeric-looking values stay strings', () => {
  // A postcode or version number must not silently become a quantity.
  const rows = fromCsv('code\r\n02134\r\n');
  assert.equal(rows[0].code, '02134');
});

test('a declared number column that is not numeric becomes null, not NaN', () => {
  const rows = fromCsv('n\r\nabc\r\n', { types: { n: 'number' } });
  assert.equal(rows[0].n, null);
});

test('FALSE parses as false rather than a truthy string', () => {
  const rows = fromCsv('b\r\nFALSE\r\n', { types: { b: 'boolean' } });
  assert.equal(rows[0].b, false);
});

test('the export-time formula guard is undone when reading back', () => {
  const rows = fromCsv("v\r\n'=SUM(A1:A9)\r\n");
  assert.equal(rows[0].v, '=SUM(A1:A9)', 'JSON consumers should see what was typed');
});

test('an apostrophe in ordinary text is preserved', () => {
  assert.equal(denormalizeFormula("it's fine"), "it's fine");
  assert.equal(fromCsv("v\r\n\"it's fine\"\r\n")[0].v, "it's fine");
});

test('round-trips values through write and read unchanged', () => {
  const rows = [
    { id: 'a', text: 'Multi\nline, with "quotes"', n: 4, ok: true },
    { id: 'b', text: '=formula', n: null, ok: false },
    { id: 'c', text: 'Café — 日本語', n: -2.5, ok: true },
  ];
  const columns = ['id', 'text', 'n', 'ok'];

  const parsed = fromCsv(toCsv(rows, columns), {
    types: { n: 'number', ok: 'boolean' },
  });

  assert.deepEqual(parsed, rows);
});

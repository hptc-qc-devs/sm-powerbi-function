/**
 * csv.js
 *
 * Serializes table rows to CSV. Pure functions, no I/O.
 *
 * CSV is the interchange format because Power BI ingests it natively, users
 * can open a synced file in Excel to sanity-check it, and it diffs and
 * streams well. The cost is that CSV has real footguns, and this module
 * exists to handle them in one place rather than at every call site:
 *
 *   - Quoting (RFC 4180). Survey answers routinely contain commas, quotes and
 *     newlines, all of which corrupt a naive join.
 *   - Formula injection. Respondents type free text, and a value beginning
 *     `=`, `+` or `@` is executed as a formula when the file is opened in a
 *     spreadsheet. See sanitizeFormulas below.
 *   - Encoding. Survey text is frequently non-ASCII; without a byte-order
 *     mark Excel guesses the codepage and mangles it.
 *   - Empty vs null. Both serialize to an empty field, which Power BI reads
 *     as blank. CSV cannot distinguish them and pretending otherwise (by
 *     writing "null") would produce a literal string in the data.
 */

const BOM = '﻿';

/**
 * @param {object[]} rows
 * @param {string[]} columns - column order; also the header row
 * @param {object} [opts]
 * @param {boolean} [opts.bom=true] - prefix a UTF-8 byte-order mark
 * @param {boolean} [opts.sanitizeFormulas=true] - neutralize formula-injection
 * @returns {string}
 */
function toCsv(rows, columns, opts = {}) {
  const { bom = true, sanitizeFormulas = true } = opts;

  const lines = [columns.map((c) => escapeField(c, false)).join(',')];

  for (const row of rows) {
    const line = columns.map((column) => escapeField(row[column], sanitizeFormulas)).join(',');
    lines.push(line);
  }

  // Trailing newline: POSIX convention, and some parsers drop the last row
  // without it.
  return (bom ? BOM : '') + lines.join('\r\n') + '\r\n';
}

/**
 * Escapes a single value per RFC 4180.
 *
 * null and undefined become empty fields. Booleans become TRUE/FALSE, which
 * Power BI recognizes as a logical type rather than importing them as text.
 */
function escapeField(value, sanitizeFormulas) {
  if (value === null || value === undefined) return '';

  let text;
  if (typeof value === 'boolean') {
    text = value ? 'TRUE' : 'FALSE';
  } else if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  } else if (value instanceof Date) {
    return value.toISOString();
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  if (sanitizeFormulas) text = neutralizeFormula(text);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Neutralizes spreadsheet formula injection.
 *
 * A cell beginning `=`, `+`, `-` or `@` is evaluated as a formula by Excel
 * and Google Sheets, so respondent-entered text is an injection vector in any
 * exported survey data. The standard mitigation is to prefix a single quote,
 * which spreadsheets treat as "render the rest literally".
 *
 * The prefix is applied only when the value is not a valid number, so a
 * legitimate negative value like "-5" is left untouched. Power BI reads the
 * prefixed value as a literal apostrophe followed by the text, which is
 * visible but harmless — and far preferable to a formula executing on open.
 */
function neutralizeFormula(text) {
  if (!/^[=+\-@\t\r]/.test(text)) return text;
  if (Number.isFinite(Number(text.trim()))) return text;
  return `'${text}`;
}

module.exports = { toCsv, escapeField, neutralizeFormula, BOM };

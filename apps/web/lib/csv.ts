// CSV export helpers.
//
// Spreadsheet apps (Excel, Google Sheets, LibreOffice) treat a cell that
// starts with = + - @ (or a tab / carriage return that they strip first) as a
// formula. Display names, task titles and handoff text in the activity log
// are user-controlled, so an exported cell like =HYPERLINK("https://evil",
// "click") would run when the file is opened (CSV / formula injection,
// Security Validation finding F16). Prefixing such cells with a single quote
// makes the spreadsheet show the text literally.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Returns the value as plain text that no spreadsheet will evaluate. */
export function neutralizeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Leading whitespace is ignored by some importers before the formula check,
  // so look past it as well.
  return FORMULA_TRIGGER.test(text) || FORMULA_TRIGGER.test(text.trimStart()) ? `'${text}` : text;
}

/** Quotes one cell per RFC 4180 after neutralising formulas. */
export function csvCell(value: unknown): string {
  return `"${neutralizeCsvCell(value).replaceAll('"', '""')}"`;
}

/** Builds a CSV document (CRLF line endings) from rows of cells. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

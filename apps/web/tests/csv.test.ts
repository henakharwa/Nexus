import { describe, expect, it } from "vitest";
import { csvCell, neutralizeCsvCell, toCsv } from "../lib/csv";

describe("CSV formula neutralisation (F16)", () => {
  it("prefixes every formula trigger with a quote", () => {
    for (const value of ['=HYPERLINK("https://evil.example","x")', "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1", "  =cmd|' /C calc'!A0"]) {
      expect(neutralizeCsvCell(value).startsWith("'"), JSON.stringify(value)).toBe(true);
    }
  });
  it("leaves ordinary text, timestamps and empty values unchanged", () => {
    expect(neutralizeCsvCell("Dhaval confirmed: open a PR")).toBe("Dhaval confirmed: open a PR");
    expect(neutralizeCsvCell("2026-10-27T22:00:00.000Z")).toBe("2026-10-27T22:00:00.000Z");
    expect(neutralizeCsvCell("a = b")).toBe("a = b");
    expect(neutralizeCsvCell(null)).toBe("");
    expect(neutralizeCsvCell(undefined)).toBe("");
  });
  it("quotes cells and doubles embedded quotes after neutralising", () => {
    expect(csvCell('=A1&"x"')).toBe(`"'=A1&""x"""`);
    expect(csvCell("plain, with comma")).toBe(`"plain, with comma"`);
  });
  it("joins rows with CRLF", () => {
    expect(toCsv([["Actor", "Activity"], ["=evil()", "ok"]])).toBe(`"Actor","Activity"\r\n"'=evil()","ok"`);
  });
});

export type ChangeFormat = "percent" | "number";
export type ChangeTone = "positive" | "negative" | "neutral";
export type Cell = string | number;

export const TABLE_ROW_CAP = 12;

// en-US on purpose: widgets render on the server and in the browser, and a locale that differs between them breaks hydration.
const numbers = new Intl.NumberFormat("en-US", { useGrouping: "min2", maximumFractionDigits: 2 });
const changes = new Intl.NumberFormat("en-US", { useGrouping: "min2", maximumFractionDigits: 2, signDisplay: "exceptZero" });

export function formatValue(value: Cell): string {
  return typeof value === "number" ? numbers.format(value) : value;
}

export function formatChange(change: number, format: ChangeFormat): string {
  const text = changes.format(change);
  return format === "percent" ? `${text}%` : text;
}

export function changeToneOf(change: number, tone?: ChangeTone | null): ChangeTone {
  if (tone) return tone;
  return change > 0 ? "positive" : change < 0 ? "negative" : "neutral";
}

const numberLike = /^[-+]?[$€£¥]?\d[\d,]*(\.\d+)?%?$/;

function isNumeric(cell: Cell) {
  return typeof cell === "number" || numberLike.test(cell.trim());
}

export function numericColumns(rows: Cell[][]): boolean[] {
  const width = rows[0]?.length ?? 0;
  return Array.from({ length: width }, (_, column) => {
    const filled = rows.map((row) => row[column]).filter((cell) => cell !== undefined && String(cell).trim() !== "");
    return filled.length > 0 && filled.every(isNumeric);
  });
}

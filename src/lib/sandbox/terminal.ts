// Output from a program is untrusted text. Terminals read escape sequences as
// instructions (colors, cursor moves, window titles, links). A card has no terminal,
// so the sequences would only show as clutter. This removes them and the control
// characters that have no use in text. Tabs and line breaks stay.

const ESC = "\\u001b";
const ST = `(?:\\u0007|${ESC}\\\\|\\u009c)`;

const sequences = new RegExp(
  [
    // OSC, DCS, SOS, PM and APC strings run until a string terminator, the next escape, or the end of the text.
    `(?:${ESC}[\\]PX^_]|[\\u0090\\u0098\\u009d\\u009e\\u009f])[\\s\\S]*?(?:${ST}|(?=${ESC})|$)`,
    // CSI: parameters, intermediates, then one final byte. Any control character cuts it short.
    `(?:${ESC}\\[|\\u009b)[\\u0030-\\u003f]*[\\u0020-\\u002f]*(?:[\\u0040-\\u007e]|(?=[\\u0000-\\u001f\\u007f-\\u009f])|$)`,
    // Any other escape sequence: ESC, optional intermediates, one final byte.
    `${ESC}[\\u0020-\\u002f]*(?:[\\u0030-\\u007e]|$)`,
  ].join("|"),
  "g",
);

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const controlCode = (code: number) =>
  (code >= 0x00 && code <= 0x08) || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);

export function stripTerminalControls(text: string): string {
  return text.replace(sequences, "").replace(/\r\n?/g, "\n").replace(controls, "");
}

export function stripTerminalControlsWithMap(text: string): { text: string; starts: Int32Array; ends: Int32Array } | null {
  if (!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) return null;
  const matcher = new RegExp(sequences.source, "g");
  const skipped = new Uint8Array(text.length);
  let hasChange = false;
  for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
    if (match[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    hasChange = true;
    skipped.fill(1, match.index, match.index + match[0].length);
  }
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (skipped[i]) continue;
    const code = text.charCodeAt(i);
    if (code === 0x0d) {
      hasChange = true;
      const nextIsLf = i + 1 < text.length && !skipped[i + 1] && text.charCodeAt(i + 1) === 0x0a;
      chars.push("\n");
      starts.push(i);
      ends.push(nextIsLf ? i + 2 : i + 1);
      if (nextIsLf) i += 1;
      continue;
    }
    if (controlCode(code)) {
      hasChange = true;
      continue;
    }
    chars.push(text[i]);
    starts.push(i);
    ends.push(i + 1);
  }
  if (!hasChange) return null;
  return { text: chars.join(""), starts: Int32Array.from(starts), ends: Int32Array.from(ends) };
}

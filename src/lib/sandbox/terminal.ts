// Output from a program is untrusted text. Terminals read escape sequences as
// instructions (colors, cursor moves, window titles, links). A card has no terminal,
// so the sequences would only show as clutter. This removes them and the control
// characters that have no use in text. Tabs and line breaks stay.

const ESC = "\\u001b";
const ST = `(?:\\u0007|${ESC}\\\\|\\u009c)`;

const sequences = new RegExp(
  [
    // OSC, DCS, SOS, PM and APC strings run until a string terminator or the end of the text.
    `(?:${ESC}[\\]PX^_]|[\\u0090\\u0098\\u009d\\u009e\\u009f])[\\s\\S]*?(?:${ST}|$)`,
    // CSI: parameters, intermediates, then one final byte.
    `(?:${ESC}\\[|\\u009b)[\\u0030-\\u003f]*[\\u0020-\\u002f]*(?:[\\u0040-\\u007e]|$)`,
    // Any other escape sequence: ESC, optional intermediates, one final byte.
    `${ESC}[\\u0020-\\u002f]*(?:[\\u0030-\\u007e]|$)`,
  ].join("|"),
  "g",
);

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function stripTerminalControls(text: string): string {
  return text.replace(sequences, "").replace(/\r\n?/g, "\n").replace(controls, "");
}

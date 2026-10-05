function parseDecimalText(value) {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(value);
  if (!match) return null;
  const integer = (match[2] ?? "0").replace(/^0+/, "") || "0";
  const fraction = (match[3] ?? match[4] ?? "").replace(/0+$/, "");
  const negative = match[1] === "-" && (integer !== "0" || fraction !== "");
  return { integer, fraction, negative };
}

// Compare decimal lexemes without converting through binary floating point.
export function compareDecimalText(left, right) {
  const a = parseDecimalText(left), b = parseDecimalText(right);
  if (!a || !b) return left.localeCompare(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const direction = a.negative ? -1 : 1;
  if (a.integer.length !== b.integer.length) return (a.integer.length < b.integer.length ? -1 : 1) * direction;
  const whole = a.integer < b.integer ? -1 : a.integer > b.integer ? 1 : 0;
  if (whole) return whole * direction;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const leftFraction = a.fraction.padEnd(width, "0"), rightFraction = b.fraction.padEnd(width, "0");
  return (leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0) * direction;
}

// Provider values follow the Go schema grammar: optional sign, integer digits
// and/or fractional digits, with at most one decimal point. Invalid text sorts in a
// separate lexical class, keeping mixed-value comparisons transitive.
export function compareDecimalValues(left, right) {
  const leftText = left == null ? null : String(left);
  const rightText = right == null ? null : String(right);
  if (leftText === null || rightText === null) return leftText === rightText ? 0 : leftText === null ? -1 : 1;
  const leftValid = parseDecimalText(leftText) !== null;
  const rightValid = parseDecimalText(rightText) !== null;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return leftValid ? compareDecimalText(leftText, rightText) : leftText.localeCompare(rightText);
}

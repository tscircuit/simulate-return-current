/** Signed peak amperes. Bare numeric values are amperes, never RMS. */
export function parseCurrentAmps(value: number | string): number {
  return parseQuantity(
    value,
    { A: 1, mA: 1e-3, uA: 1e-6, µA: 1e-6, μA: 1e-6, nA: 1e-9 },
    "current",
    false,
  )
}

/** Real, positive resistance only; complex impedances are not supported. */
export function parseResistanceOhms(value: number | string): number {
  return parseQuantity(
    value,
    {
      mohm: 1e-3,
      mOhm: 1e-3,
      mΩ: 1e-3,
      ohm: 1,
      ohms: 1,
      Ohm: 1,
      Ohms: 1,
      Ω: 1,
      kohm: 1e3,
      kOhm: 1e3,
      kΩ: 1e3,
      Mohm: 1e6,
      MOhm: 1e6,
      MΩ: 1e6,
    },
    "resistance",
    true,
  )
}

function parseQuantity(
  value: number | string,
  units: Record<string, number>,
  label: string,
  positive: boolean,
): number {
  let result: number
  if (typeof value === "number") result = value
  else if (typeof value === "string") {
    const match =
      /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)\s*$/.exec(
        value,
      )
    const scale = match ? (match[2] === "" ? 1 : units[match[2]]) : undefined
    if (!match || scale === undefined)
      throw new Error(
        `Invalid ${label} "${value}"; supported units: ${Object.keys(units).join(", ")}`,
      )
    result = Number(match[1]) * scale
  } else throw new Error(`${label} must be a number or a value with units`)
  if (!Number.isFinite(result) || (positive && result <= 0))
    throw new Error(
      `${label} must be finite${positive ? " and greater than zero" : ""}`,
    )
  return result
}

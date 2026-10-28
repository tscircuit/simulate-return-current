import type { PcbTrace } from "circuit-json"

/** Core may emit wire→via→via→wire without duplicate wire vertices at vias. */
export function normalizeLayeredRoute(trace: PcbTrace): PcbTrace {
  // Some routers store standalone via records; physical barrels are validated separately.
  if (
    trace.route.length &&
    trace.route.every((point) => point.route_type === "via")
  )
    return trace
  const route: PcbTrace["route"] = []
  for (const [index, point] of trace.route.entries()) {
    if (point.route_type === "wire") {
      route.push(point)
      continue
    }
    if (point.route_type !== "via")
      throw new Error("Through-pad route points are not supported")
    const previous = route.at(-1)
    const next = trace.route[index + 1]
    if (!previous || previous.route_type !== "wire" || !next)
      throw new Error("Via needs signal route endpoints on both sides")
    if (previous.layer !== point.from_layer)
      throw new Error("Via from_layer does not match preceding wire layer")
    if (previous.x !== point.x || previous.y !== point.y)
      route.push({
        route_type: "wire",
        x: point.x,
        y: point.y,
        width: previous.width,
        layer: point.from_layer,
      })
    route.push(point)
    if (next.route_type !== "wire" || next.x !== point.x || next.y !== point.y)
      route.push({
        route_type: "wire",
        x: point.x,
        y: point.y,
        width: next.route_type === "wire" ? next.width : previous.width,
        layer: point.to_layer,
      })
  }
  return { ...trace, route }
}

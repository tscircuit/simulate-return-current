import { normalizeLayeredRoute } from "./normalize-layered-route"
import type { PcbTrace, Point } from "circuit-json"
import { cutoutOutline, rectangleOutline, pointInPolygon } from "../geometry"
import { positiveFinite, pourRegion } from "../read-geometry"
import type { SimulationGeometry, SignalSegment } from "../types"
import { copperConnectivity } from "./copper-connectivity"
import {
  drillOutline,
  platedPadOutline,
  roundedOutline,
  traceOutline,
  smtPadOutline,
} from "./copper-outlines"
import { physicalStackup, type CopperLayer } from "./stackup"
import type {
  PalaceLayeredGeometry,
  PalaceModel,
  PalaceOptions,
  PalaceTerminalPort,
} from "./types"

type CopperKey = string
type PcbTraceId = string

export function createMultilayerPalaceModel(
  options: PalaceOptions,
): PalaceModel {
  options = {
    ...options,
    circuitJson: options.circuitJson.map((e) =>
      e.type === "pcb_trace" ? normalizeLayeredRoute(e) : e,
    ),
  }
  const boards = options.circuitJson.filter((e) => e.type === "pcb_board")
  if (boards.length !== 1) throw new Error("Exactly one PCB board is required")
  const board = boards[0]
  const copperModel = options.copperModel ?? "volumetric_copper"
  if (
    copperModel !== "volumetric_copper" &&
    copperModel !== "surface_impedance_copper"
  )
    throw new Error("Unknown copperModel")
  if (!options.stackup)
    throw new Error(
      "Multilayer boards require an explicit fabrication stackup (--stackup-file); layer spacing is not inferred",
    )
  if (!Number.isInteger(board.num_layers) || board.num_layers < 2)
    throw new Error("Board must have at least two copper layers")
  if (
    options.layerSeparation !== undefined ||
    options.copperThickness !== undefined
  )
    throw new Error(
      "Use stackup layer thicknesses instead of layerSeparation/copperThickness",
    )
  const substrateLossTangent = options.substrateLossTangent ?? 0.02
  if (!Number.isFinite(substrateLossTangent) || substrateLossTangent < 0)
    throw new Error("substrateLossTangent must be finite and nonnegative")
  const stackup = physicalStackup({
    stackup: options.stackup,
    numLayers: board.num_layers,
    lossTangent: substrateLossTangent,
  })
  const sampleLayer = options.sampleLayer ?? "bottom"
  const sampleFoil = stackup.copperLayers.find(
    (layer) => layer.name === sampleLayer,
  )
  if (!sampleFoil)
    throw new Error(`Sample layer ${sampleLayer} is absent from the stackup`)
  const frequencyHz = positiveFinite(options.frequencyHz, "frequencyHz")
  const copperConductivity = positiveFinite(
    options.copperConductivity ?? 5.8e7,
    "copperConductivity",
  )
  const skinDepthMm =
    1000 /
    Math.sqrt(Math.PI * frequencyHz * 4e-7 * Math.PI * copperConductivity)
  if (
    copperModel === "volumetric_copper" &&
    stackup.copperLayers.some((layer) => layer.zMax - layer.zMin > skinDepthMm)
  )
    throw new Error(
      "The current volume mesher requires copper thickness <= skin depth; refine copper through its thickness before using higher frequencies",
    )
  const excitations =
    options.excitations ??
    options.circuitJson.filter(
      (e) => e.type === "simulation_return_current_excitation",
    )
  const groundIds = new Set(excitations.map((e) => e.ground_source_net_id))
  if (!excitations.length || groundIds.size !== 1)
    throw new Error("Specify excitations sharing one reference net")
  const referenceNetId = excitations[0].ground_source_net_id
  const connectivity = copperConnectivity(options.circuitJson)
  let boardOutline = board.outline?.length
    ? board.outline
    : rectangleOutline({
        center: board.center,
        width: board.width ?? 0,
        height: board.height ?? 0,
      })
  const region = options.region
  if (region) {
    if (board.outline?.length || !board.width || !board.height)
      throw new Error(
        "Local regions currently require a rectangular PCB outline",
      )
    const { minX, minY, maxX, maxY } = region
    if (
      ![minX, minY, maxX, maxY].every(Number.isFinite) ||
      minX >= maxX ||
      minY >= maxY
    )
      throw new Error("Local region must have finite positive dimensions")
    if (
      minX < board.center.x - board.width / 2 ||
      maxX > board.center.x + board.width / 2 ||
      minY < board.center.y - board.height / 2 ||
      maxY > board.center.y + board.height / 2
    )
      throw new Error("Local region must lie inside the original PCB")
    boardOutline = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]
    for (const excitation of excitations) {
      const trace = options.circuitJson.find(
        (e) =>
          e.type === "pcb_trace" && e.pcb_trace_id === excitation.pcb_trace_id,
      )
      if (trace?.type !== "pcb_trace") throw new Error("Missing excited trace")
      const points = trace.route.flatMap((point) => {
        if (point.route_type === "through_pad")
          throw new Error("Through-pad signal routes are unsupported")
        return [
          {
            x: point.x,
            y: point.y,
            radius: point.route_type === "wire" ? point.width / 2 : 0,
          },
        ]
      })
      for (const point of [
        ...points,
        { ...excitation.return_source, radius: 0 },
        { ...excitation.return_sink, radius: 0 },
      ]) {
        const radius = point.radius
        if (
          point.x - radius <= minX ||
          point.x + radius >= maxX ||
          point.y - radius <= minY ||
          point.y + radius >= maxY
        )
          throw new Error(
            "Local region must contain the complete signal and both return contacts with clearance",
          )
      }
    }
  }
  const boardCutouts = options.circuitJson
    .filter((e) => e.type === "pcb_cutout")
    .map(cutoutOutline)
  const viaClearance = positiveFinite(
    options.viaClearance ?? board.min_trace_to_pad_edge_clearance ?? 0.2,
    "viaClearance",
  )
  const layered: PalaceLayeredGeometry = {
    stackup,
    ...(region ? { region } : {}),
    sampleLayer,
    referenceNetId,
    viaClearance,
    copper: [],
    drills: [],
    barrels: [],
    boardCutouts,
    audit: {
      traces: 0,
      vias: 0,
      pads: 0,
      platedHoles: 0,
      unplatedHoles: 0,
      pours: 0,
      omittedCopperElements: 0,
      warnings: [
        "Component bodies, package/decoupling impedances, solder mask and silkscreen are not modeled.",
        "Circular copper/drills use 32-sided polygons. Via plating uses 0.025 mm; override support is not yet provided.",
      ],
    },
  }
  const copperByKey = new Map<
    CopperKey,
    PalaceLayeredGeometry["copper"][number]
  >()
  const platedWalls = new Map<
    PalaceLayeredGeometry["barrels"][number],
    Point[]
  >()
  for (const layer of stackup.copperLayers)
    for (const netId of [referenceNetId]) {
      const copper = { layer: layer.name, netId, regions: [], segments: [] }
      copperByKey.set(`${layer.name}:${netId}`, copper)
      layered.copper.push(copper)
    }
  const traces = new Map<PcbTraceId, PcbTrace>()
  for (const element of options.circuitJson) {
    if (element.type === "pcb_trace") traces.set(element.pcb_trace_id, element)
    const additions: {
      layer: string
      netId: string
      region?: import("../types").CopperRegion
      segment?: SignalSegment
    }[] = []
    if (element.type === "pcb_copper_pour") {
      if (!element.source_net_id)
        throw new Error("Copper pours require a source_net_id")
      additions.push({
        layer: element.layer,
        netId: connectivity.owner(element.source_net_id),
        region: { ...pourRegion(element), isPlane: true },
      })
      layered.audit.pours++
    }
    if (element.type === "pcb_ground_plane_region") {
      const plane = options.circuitJson.find(
        (e) =>
          e.type === "pcb_ground_plane" &&
          e.pcb_ground_plane_id === element.pcb_ground_plane_id,
      )
      if (!plane || plane.type !== "pcb_ground_plane")
        throw new Error("Missing ground-plane owner")
      additions.push({
        layer: element.layer,
        netId: connectivity.owner(plane.source_net_id),
        region: { outer: element.points, holes: [], isPlane: true },
      })
    }
    if (element.type === "pcb_smtpad") {
      const netId = element.pcb_port_id
        ? connectivity.pcbPorts.get(element.pcb_port_id)
        : undefined
      if (!netId)
        throw new Error(
          `Pad ${element.pcb_smtpad_id} has no PCB port ownership`,
        )
      additions.push({
        layer: element.layer,
        netId,
        region: { outer: smtPadOutline(element), holes: [] },
      })
      layered.audit.pads++
    }
    if (element.type === "pcb_trace") {
      const netId = connectivity.pcbTraces.get(element.pcb_trace_id)!
      validateLayeredRoute(
        element,
        stackup.copperLayers.map((l) => l.name),
      )
      for (let index = 1; index < element.route.length; index++) {
        const start = element.route[index - 1],
          end = element.route[index]
        if (start.route_type !== "wire" || end.route_type !== "wire") continue
        if (start.x === end.x && start.y === end.y) continue
        additions.push({
          layer: start.layer,
          netId,
          segment: {
            start,
            end,
            width: positiveFinite(start.width, "trace width"),
            current: 0,
          },
        })
      }
      layered.audit.traces++
    }
    for (const addition of additions) {
      if (!stackup.copperLayers.some((l) => l.name === addition.layer))
        throw new Error(`Copper on absent layer ${addition.layer}`)
      const key = `${addition.layer}:${addition.netId}`
      let copper = copperByKey.get(key)
      if (!copper) {
        copper = {
          layer: addition.layer as CopperLayer,
          netId: addition.netId,
          regions: [],
          segments: [],
        }
        copperByKey.set(key, copper)
        layered.copper.push(copper)
      }
      if (addition.region) copper.regions.push(addition.region)
      if (addition.segment) copper.segments.push(addition.segment)
    }
  }
  const bottom = stackup.copperLayers.at(-1)!,
    top = stackup.copperLayers[0]
  for (const element of options.circuitJson) {
    if (element.type === "pcb_hole") {
      layered.drills.push({
        hole: drillOutline(element),
        zMin: bottom.zMin,
        zMax: top.zMax,
      })
      layered.audit.unplatedHoles++
    }
    if (element.type !== "pcb_via" && element.type !== "pcb_plated_hole")
      continue
    const netId =
      element.type === "pcb_via"
        ? element.source_net_id
          ? connectivity.owner(element.source_net_id)
          : element.pcb_trace_id
            ? connectivity.pcbTraces.get(element.pcb_trace_id)
            : undefined
        : element.pcb_port_id
          ? connectivity.pcbPorts.get(element.pcb_port_id)
          : undefined
    if (!netId)
      throw new Error(
        `Cannot identify copper ownership for ${element.type}; supply source_net_id or pcb_trace_id`,
      )
    const layers = element.layers.map((name) =>
      stackup.copperLayers.find((l) => l.name === name),
    )
    if (!layers.length || layers.some((l) => !l))
      throw new Error("Via/hole references an absent stackup layer")
    const zMin = Math.min(...layers.map((l) => l!.zMin)),
      zMax = Math.max(...layers.map((l) => l!.zMax))
    const hole =
      element.type === "pcb_via"
        ? roundedOutline({
            ...element,
            width: element.hole_diameter,
            height: element.hole_diameter,
          })
        : drillOutline(element)
    const pads =
      element.type === "pcb_via"
        ? roundedOutline({
            ...element,
            width: element.outer_diameter,
            height: element.outer_diameter,
          })
        : platedPadOutline(element)
    // Mesher offsets this hole by plating thickness, including slotted holes.
    const barrel = {
      netId,
      hole,
      outer: hole,
      pads,
      layers: element.layers as CopperLayer[],
      zMin,
      zMax,
      platingThickness: 0.025,
    }
    layered.barrels.push(barrel)
    // The sample mask needs the plated wall's outer outline; 1 um extra covers
    // the mesher's mitred offset of the polygonal hole.
    const wall = 2 * (barrel.platingThickness + 0.001)
    platedWalls.set(
      barrel,
      element.type === "pcb_via"
        ? roundedOutline({
            ...element,
            width: element.hole_diameter + wall,
            height: element.hole_diameter + wall,
          })
        : drillOutline(
            "hole_diameter" in element
              ? {
                  ...element,
                  hole_diameter: (element.hole_diameter ?? 0) + wall,
                }
              : {
                  ...element,
                  hole_width: (element.hole_width ?? 0) + wall,
                  hole_height: (element.hole_height ?? 0) + wall,
                },
          ),
    )
    layered.drills.push({ hole, zMin, zMax })
    if (element.type === "pcb_via") layered.audit.vias++
    else layered.audit.platedHoles++
  }
  // Every routed layer transition must correspond to a physical plated via.
  for (const trace of traces.values())
    for (const route of trace.route) {
      if (route.route_type !== "via") continue
      const barrel = layered.barrels.find(
        (b) =>
          b.netId === connectivity.pcbTraces.get(trace.pcb_trace_id) &&
          pointInPolygon(route, b.hole) &&
          b.layers.includes(route.from_layer as CopperLayer) &&
          b.layers.includes(route.to_layer as CopperLayer),
      )
      if (!barrel)
        throw new Error(
          `Trace ${trace.pcb_trace_id} changes layer without a matching physical pcb_via`,
        )
    }
  if (region) {
    const intersects = (points: { x: number; y: number }[]) =>
      Math.max(...points.map((p) => p.x)) > region.minX &&
      Math.min(...points.map((p) => p.x)) < region.maxX &&
      Math.max(...points.map((p) => p.y)) > region.minY &&
      Math.min(...points.map((p) => p.y)) < region.maxY
    layered.barrels = layered.barrels.filter((barrel) =>
      intersects(barrel.pads),
    )
    layered.drills = layered.drills.filter((drill) => intersects(drill.hole))
    layered.audit.warnings.push(
      "Local-region approximation: all nets are clipped at the specified rectangle; omitted remote return paths and cut boundaries can change the field. Compare larger margins for convergence.",
    )
  }
  for (const barrel of layered.barrels)
    barrel.clearance = barrelClearanceOutline(barrel, viaClearance)
  const groundCopper = copperByKey.get(`${sampleLayer}:${referenceNetId}`)!
  if (!groundCopper.regions.length)
    throw new Error(
      `Reference net needs copper regions on sample layer ${sampleLayer}; no plane is invented`,
    )
  const geometry: SimulationGeometry = {
    board,
    boardOutline,
    groundRegions: groundCopper.regions.map((region) => ({
      ...region,
      holes: [...region.holes],
    })),
    cutouts: [...boardCutouts],
    signals: [],
    segments: [],
    excitations,
  }
  // Match the planar mesher mask without requiring Python for --prepare-only.
  for (const segment of groundCopper.segments) {
    geometry.groundRegions.push({
      outer: traceOutline(segment),
      holes: [],
    })
  }
  for (const barrel of layered.barrels) {
    if (barrel.zMin > sampleFoil.zMin || barrel.zMax < sampleFoil.zMax) continue
    if (barrel.netId === referenceNetId && barrel.layers.includes(sampleLayer))
      geometry.groundRegions.push({ outer: barrel.pads, holes: [barrel.hole] })
    else if (barrel.netId !== referenceNetId) {
      // Antipad conservative bounding capsule; exact drill/pad polygons remain
      // in the FEM geometry. All barrels use this same clearance footprint.
      for (const region of geometry.groundRegions.filter(
        (region) => region.isPlane,
      ))
        region.maskCutouts = [
          ...(region.maskCutouts ?? []),
          barrelClearanceOutline(barrel, viaClearance),
        ]
    }
  }
  for (const drill of layered.drills)
    if (drill.zMin <= sampleFoil.zMin && drill.zMax >= sampleFoil.zMax)
      geometry.cutouts.push(drill.hole)
  // A reference barrel continuing past both faces of the sample foil joins it
  // through its plated wall, so no foil face exists there to sample.
  for (const barrel of layered.barrels)
    if (
      barrel.netId === referenceNetId &&
      barrel.zMin < sampleFoil.zMin - 1e-9 &&
      barrel.zMax > sampleFoil.zMax + 1e-9
    )
      geometry.cutouts.push(platedWalls.get(barrel)!)
  const ports: PalaceTerminalPort[] = []
  for (const excitation of excitations) {
    if (!Number.isFinite(excitation.current))
      throw new Error("Excitation current must be finite")
    const trace = traces.get(excitation.pcb_trace_id)
    if (!trace) throw new Error("Missing excited trace")
    geometry.signals.push(trace)
    for (let index = 1; index < trace.route.length; index++) {
      const start = trace.route[index - 1],
        end = trace.route[index]
      if (
        start.route_type === "wire" &&
        end.route_type === "wire" &&
        (start.x !== end.x || start.y !== end.y)
      )
        geometry.segments.push({
          start,
          end,
          width: start.width,
          current: excitation.current,
        })
    }
    for (const [endpoint, reference, terminal] of [
      [trace.route[0], excitation.return_sink, excitation.source_port],
      [trace.route.at(-1)!, excitation.return_source, excitation.load_port],
    ] as const) {
      if (endpoint.route_type !== "wire")
        throw new Error("Ports require wire endpoints")
      const signalFoil = stackup.copperLayers.find(
        (l) => l.name === endpoint.layer,
      )!
      const referenceFoil = stackup.copperLayers.find(
        (l) => l.name === (terminal?.reference_layer ?? sampleLayer),
      )
      if (!referenceFoil) throw new Error("Reference layer is absent")
      if (
        terminal?.reference_pcb_port_id &&
        connectivity.pcbPorts.get(terminal.reference_pcb_port_id) !==
          referenceNetId
      )
        throw new Error("Reference pin is not on the reference net")
      for (const [id, position, layer] of [
        [terminal?.signal_pcb_port_id, endpoint, endpoint.layer],
        [terminal?.reference_pcb_port_id, reference, referenceFoil.name],
      ] as const) {
        if (!id) continue
        const pcb = options.circuitJson.find(
          (e) => e.type === "pcb_port" && e.pcb_port_id === id,
        )
        if (
          !pcb ||
          pcb.type !== "pcb_port" ||
          !pcb.layers.includes(layer) ||
          Math.hypot(pcb.x - position.x, pcb.y - position.y) > 1e-6
        )
          throw new Error("Terminal does not match its PCB port position/layer")
      }
      const below = referenceFoil.zMin < signalFoil.zMin
      ports.push({
        signal: { x: endpoint.x, y: endpoint.y },
        reference: { x: reference.x, y: reference.y },
        signalLayer: signalFoil.name,
        referenceLayer: referenceFoil.name,
        signalZ: below ? signalFoil.zMin : signalFoil.zMax,
        referenceZ: below
          ? referenceFoil.zMax
          : referenceFoil.zMin === signalFoil.zMin
            ? signalFoil.zMax
            : referenceFoil.zMin,
        resistance: positiveFinite(
          terminal?.resistance ?? options.portResistance ?? 50,
          "port resistance",
        ),
        signalPcbPortId: terminal?.signal_pcb_port_id,
        referencePcbPortId: terminal?.reference_pcb_port_id,
      })
    }
  }
  if (
    stackup.nominalBoardThicknessMm &&
    Math.abs(stackup.physicalThicknessMm - stackup.nominalBoardThicknessMm) >
      1e-4
  )
    layered.audit.warnings.push(
      `Explicit stack sums to ${stackup.physicalThicknessMm} mm, nominal ${stackup.nominalBoardThicknessMm} mm; explicit dimensions are used without scaling.`,
    )
  const minimumCopperThickness = Math.min(
    ...stackup.copperLayers.map((layer) => layer.zMax - layer.zMin),
    ...layered.barrels.map((barrel) => barrel.platingThickness),
  )
  if (
    copperModel === "surface_impedance_copper" &&
    minimumCopperThickness < 3 * skinDepthMm
  )
    throw new Error(
      "The half-space surface-impedance model requires every foil and via-wall thickness >= 3 skin depths; use volumetric copper at lower frequencies",
    )
  // Round like the rest of the geometry signature: libm differs between macOS
  // and Linux in the last bit of some polygon vertices.
  geometry.physicalModelSignature = JSON.stringify(
    {
      ...layered,
      traceEndCaps: "round_32",
      audit: undefined,
    },
    (_, value) =>
      typeof value === "number" ? Number(value.toFixed(9)) : value,
  )
  const order = options.order ?? 2
  if (order !== 1 && order !== 2) throw new Error("order must be 1 or 2")
  return {
    schemaVersion: 1,
    multilayer: layered,
    geometry,
    ports,
    topPads: [],
    frequencyHz,
    layerSeparation: top.zMin - bottom.zMax,
    copperThickness: sampleFoil.zMax - sampleFoil.zMin,
    copperConductivity,
    substratePermittivity: options.substratePermittivity ?? 4.3,
    substrateLossTangent,
    portResistance: positiveFinite(
      options.portResistance ?? 50,
      "portResistance",
    ),
    portWidth: positiveFinite(options.portWidth ?? 0.18, "portWidth"),
    meshSize: positiveFinite(options.meshSize ?? 1, "meshSize"),
    airPadding: positiveFinite(options.airPadding ?? 10, "airPadding"),
    order,
    copperModel,
    ...(copperModel === "surface_impedance_copper"
      ? {
          surfaceImpedance: {
            boundaryModel: "half_space" as const,
            skinDepthMm,
            minimumThicknessToSkinDepth: minimumCopperThickness / skinDepthMm,
            currentSampling: "sum_foil_face_surface_currents" as const,
          },
        }
      : {}),
  }
}

function validateLayeredRoute(trace: PcbTrace, layers: string[]) {
  for (const [index, route] of trace.route.entries()) {
    if (route.route_type !== "wire" && route.route_type !== "via")
      throw new Error("Unsupported route point type")
    if (![route.x, route.y].every(Number.isFinite))
      throw new Error("Trace coordinates must be finite")
    if (route.route_type === "wire") {
      positiveFinite(route.width, "trace width")
      if (!layers.includes(route.layer))
        throw new Error(`Unknown route layer ${route.layer}`)
      const previous = trace.route[index - 1]
      if (previous?.route_type === "wire" && previous.layer !== route.layer)
        throw new Error("Layer transitions require a via route point")
    } else if (route.route_type === "via") {
      if (
        !layers.includes(route.from_layer) ||
        !layers.includes(route.to_layer)
      )
        throw new Error("Unknown via route layer")
      if (trace.route.every((point) => point.route_type === "via")) continue
      const previous = trace.route[index - 1],
        next = trace.route[index + 1]
      if (
        previous?.route_type !== "wire" ||
        next?.route_type !== "wire" ||
        previous.layer !== route.from_layer ||
        next.layer !== route.to_layer ||
        Math.hypot(previous.x - route.x, previous.y - route.y) > 1e-6 ||
        Math.hypot(next.x - route.x, next.y - route.y) > 1e-6
      )
        throw new Error(
          "Via route must join matching, colocated layer endpoints",
        )
    } else throw new Error("Unsupported route point type")
  }
}

export function barrelClearanceOutline(
  barrel: PalaceLayeredGeometry["barrels"][number],
  clearance: number,
): Point[] {
  const xs = barrel.pads.map((p) => p.x),
    ys = barrel.pads.map((p) => p.y)
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys)
  // Rotated/noncircular plated holes use an explicit rectangular bounding
  // antipad. Preserve the manufactured drill/pad; only clearance is conservative.
  return rectangleOutline({
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    width: maxX - minX + 2 * clearance,
    height: maxY - minY + 2 * clearance,
  })
}

import { createMultilayerPalaceModel } from "./create-multilayer-model"
import { rectangleOutline, isCopper } from "../geometry"
import { positiveFinite, readGeometry } from "../read-geometry"
import { portNetIds } from "../port-connectivity"
import type { PalaceModel, PalaceOptions, PalaceTerminalPort } from "./types"

export function createPalaceModel(options: PalaceOptions): PalaceModel {
  if (options.region && !options.stackup)
    throw new Error("Local regions require an explicit fabrication stackup")
  if (
    options.stackup ||
    options.circuitJson.some(
      (element) => element.type === "pcb_board" && element.num_layers > 2,
    )
  )
    return createMultilayerPalaceModel(options)
  if (options.sampleLayer && options.sampleLayer !== "bottom")
    throw new Error("A non-bottom sample layer requires an explicit stackup")
  const frequencyHz = positiveFinite(options.frequencyHz, "frequencyHz")
  // Only Palace models the restricted ground via geometry below. The preview
  // solver continues to reject drilled boards instead of silently ignoring vias.
  const geometry = readGeometry({
    ...options,
    circuitJson: options.circuitJson.filter(
      (element) => element.type !== "pcb_via",
    ),
  })
  const layerSeparation = positiveFinite(
    options.layerSeparation ?? geometry.board.thickness ?? 0.8,
    "layerSeparation",
  )
  const copperThickness = positiveFinite(
    options.copperThickness ?? 0.035,
    "copperThickness",
  )
  const copperConductivity = positiveFinite(
    options.copperConductivity ?? 5.8e7,
    "copperConductivity",
  )
  const skinDepthMm =
    1000 /
    Math.sqrt(Math.PI * frequencyHz * 4e-7 * Math.PI * copperConductivity)
  const copperModel = options.copperModel ?? "volumetric_copper"
  if (
    copperModel !== "volumetric_copper" &&
    copperModel !== "surface_impedance_copper"
  )
    throw new Error("Unknown copperModel")
  if (
    copperModel === "surface_impedance_copper" &&
    copperThickness < 3 * skinDepthMm
  )
    throw new Error(
      "The half-space surface-impedance model requires foil and via-wall thickness >= 3 skin depths; use volumetric copper at lower frequencies",
    )
  if (copperModel === "volumetric_copper" && copperThickness > skinDepthMm)
    throw new Error(
      "The current volume mesher requires copper thickness <= skin depth; refine copper through its thickness before using higher frequencies",
    )
  const ports: PalaceTerminalPort[] = []
  for (const [index, signal] of geometry.signals.entries()) {
    const first = signal.route[0]
    const last = signal.route.at(-1)
    const excitation = geometry.excitations[index]
    if (!last || first.route_type !== "wire" || last.route_type !== "wire")
      throw new Error("Palace requires wire endpoints")
    for (const [endpoint, contact, terminal] of [
      [first, excitation.return_sink, excitation.source_port],
      [last, excitation.return_source, excitation.load_port],
    ] as const) {
      if (
        !terminal &&
        Math.hypot(endpoint.x - contact.x, endpoint.y - contact.y) > 1e-6
      )
        throw new Error(
          "Legacy Palace ports require return contacts directly below signal endpoints; specify explicit terminal metadata for offset references",
        )
      for (const [id, position, role] of [
        [terminal?.signal_pcb_port_id, endpoint, "signal"],
        [terminal?.reference_pcb_port_id, contact, "reference"],
      ] as const) {
        if (!id) continue
        const pcb = options.circuitJson.find(
          (element) =>
            element.type === "pcb_port" && element.pcb_port_id === id,
        )
        if (
          !pcb ||
          pcb.type !== "pcb_port" ||
          Math.hypot(pcb.x - position.x, pcb.y - position.y) > 1e-6
        )
          throw new Error(
            `Explicit ${role} terminal does not match its PCB port`,
          )
        const layer = role === "signal" ? "top" : terminal!.reference_layer
        if (!pcb.layers.includes(layer))
          throw new Error(`Explicit ${role} terminal is not on ${layer}`)
        if (
          role === "reference" &&
          !portNetIds(options.circuitJson, pcb.source_port_id).includes(
            excitation.ground_source_net_id,
          )
        )
          throw new Error(
            "Explicit reference terminal is not connected to the ground net",
          )
      }
      if (
        terminal?.reference_layer === "top" &&
        !terminal.reference_pcb_port_id
      )
        throw new Error("Top reference requires an explicit PCB port")
      ports.push({
        signal: { x: endpoint.x, y: endpoint.y },
        reference: { x: contact.x, y: contact.y },
        referenceLayer: terminal?.reference_layer ?? "bottom",
        resistance: positiveFinite(
          terminal?.resistance ?? options.portResistance ?? 50,
          "port resistance",
        ),
        signalPcbPortId: terminal?.signal_pcb_port_id,
        referencePcbPortId: terminal?.reference_pcb_port_id,
      })
    }
  }
  const referenceIds = new Set(
    ports
      .filter((port) => port.referenceLayer === "top")
      .map((port) => port.referencePcbPortId),
  )
  const topGroundPads: PalaceModel["topGroundPads"] = []
  const topPads = options.circuitJson.flatMap((element) => {
    if (element.type !== "pcb_smtpad" || element.layer !== "top") return []
    if (element.shape !== "rect")
      throw new Error("Palace currently supports rectangular top SMT pads")
    const outline = rectangleOutline({
      center: { x: element.x, y: element.y },
      width: element.width,
      height: element.height,
    })
    if (referenceIds.has(element.pcb_port_id)) {
      topGroundPads.push(outline)
      return []
    }
    return [outline]
  })
  const groundVias = options.circuitJson.flatMap((element) => {
    if (element.type !== "pcb_via") return []
    const pad = options.circuitJson.find(
      (pad) =>
        pad.type === "pcb_smtpad" &&
        pad.shape === "rect" &&
        pad.layer === "top" &&
        referenceIds.has(pad.pcb_port_id) &&
        Math.hypot(pad.x - element.x, pad.y - element.y) < 1e-6,
    )
    if (
      !pad ||
      pad.type !== "pcb_smtpad" ||
      pad.shape !== "rect" ||
      element.source_net_id !== geometry.excitations[0].ground_source_net_id ||
      !element.layers.includes("top") ||
      !element.layers.includes("bottom") ||
      element.layers.length !== 2
    )
      throw new Error(
        "Only top-to-bottom ground vias centered in selected rectangular reference pads are supported",
      )
    const holeDiameter = positiveFinite(
      element.hole_diameter,
      "via hole diameter",
    )
    const outerDiameter = positiveFinite(
      element.outer_diameter,
      "via outer diameter",
    )
    if (
      holeDiameter + 2 * copperThickness >= outerDiameter ||
      outerDiameter > Math.min(pad.width, pad.height) ||
      !isCopper(element, geometry)
    )
      throw new Error(
        "Ground via needs a plated barrel inside its pad and selected bottom copper",
      )
    return [
      {
        x: element.x,
        y: element.y,
        holeDiameter,
        outerDiameter,
        platingThickness: copperThickness,
      },
    ]
  })
  for (const port of ports.filter((port) => port.referenceLayer === "top")) {
    if (
      !groundVias.some(
        (via) =>
          Math.hypot(via.x - port.reference.x, via.y - port.reference.y) < 1e-6,
      )
    )
      throw new Error(
        "A top reference pad needs a real concentric ground via in circuit-json; ground-pad names alone do not connect copper",
      )
  }
  // Keep drilled voids in the shared sample mask and image geometry too.
  for (const via of groundVias)
    geometry.cutouts.push(
      Array.from({ length: 32 }, (_, index) => ({
        x:
          via.x + (via.holeDiameter / 2) * Math.cos((index * 2 * Math.PI) / 32),
        y:
          via.y + (via.holeDiameter / 2) * Math.sin((index * 2 * Math.PI) / 32),
      })),
    )
  const substrateLossTangent = options.substrateLossTangent ?? 0.02
  if (!Number.isFinite(substrateLossTangent) || substrateLossTangent < 0)
    throw new Error("substrateLossTangent must be finite and nonnegative")
  const order = options.order ?? 2
  if (order !== 1 && order !== 2) throw new Error("order must be 1 or 2")
  return {
    schemaVersion: 1,
    geometry,
    topPads,
    topGroundPads,
    groundVias,
    ports,
    frequencyHz,
    layerSeparation,
    copperThickness,
    copperConductivity,
    substratePermittivity: positiveFinite(
      options.substratePermittivity ?? 4.3,
      "substratePermittivity",
    ),
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
            minimumThicknessToSkinDepth: copperThickness / skinDepthMm,
            currentSampling: "sum_foil_face_surface_currents" as const,
          },
        }
      : {}),
  }
}

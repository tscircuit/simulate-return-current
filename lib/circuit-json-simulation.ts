import { randomUUID } from "node:crypto"
import { gzipSync } from "node:zlib"
import { Resvg } from "@resvg/resvg-js"
import {
  simulation_return_current_excitation,
  simulation_pcb_return_current_result,
  simulation_pcb_return_current_field,
  simulation_pcb_return_current_heatmap,
  simulation_pcb_return_current_marker,
  getSimulationReturnCurrentGridJsonSchema,
  type SimulationReturnCurrentExcitation as OfficialExcitation,
  type SimulationReturnCurrentGridJson,
  type SimulationPcbReturnCurrentField,
  type SimulationPcbReturnCurrentMarker,
  type PcbTrace,
} from "circuit-json"
import type { ReturnCurrentCircuitJson, SimulationResult } from "./types"
import type { PalaceModel, PalaceReference } from "./palace/types"
import type { CopperLayer } from "./palace/stackup"
import { readGeometry } from "./read-geometry"
import { validatePalaceReference } from "./palace/validate-reference"
import { currentColor } from "./current-color"
import { palaceGeometrySignature } from "./palace/geometry-signature"
import { createPalaceModel } from "./palace/create-palace-model"
import { createSampleMask } from "./palace/create-sample-mask"
import { selectReturnCurrentExperiment } from "./circuit-json-experiment"
export {
  createReturnCurrentExperiment,
  selectReturnCurrentExperiment,
} from "./circuit-json-experiment"

function fabricationStackup(model: PalaceModel) {
  if (!model.multilayer) return undefined
  const stackup = model.multilayer.stackup
  return {
    nominalBoardThicknessMm: stackup.nominalBoardThicknessMm,
    layers: [
      ...stackup.copperLayers.map((foil) => ({
        z: foil.zMax,
        value: { name: foil.name, copperThicknessMm: foil.zMax - foil.zMin },
      })),
      ...stackup.dielectrics.map((d) => ({
        z: d.zMax,
        value: {
          material: d.material,
          dielectricThicknessMm: d.zMax - d.zMin,
          dielectricConstant: d.dielectricConstant,
          lossTangent: d.lossTangent,
        },
      })),
    ]
      .sort((a, b) => b.z - a.z)
      .map((l) => l.value),
  }
}

const id = (prefix: string) => `${prefix}_${randomUUID()}`

function markersFor(
  circuitJson: ReturnCurrentCircuitJson,
  excitations: OfficialExcitation[],
  resultId: string,
): SimulationPcbReturnCurrentMarker[] {
  const markers: SimulationPcbReturnCurrentMarker[] = []
  const portMarker = (
    role: "signal_source" | "signal_load" | "return_source" | "return_sink",
    portId: string,
    layer: CopperLayer,
  ) => {
    markers.push(
      simulation_pcb_return_current_marker.parse({
        type: "simulation_pcb_return_current_marker",
        simulation_pcb_return_current_marker_id: id(
          "simulation_pcb_return_current_marker",
        ),
        simulation_pcb_return_current_result_id: resultId,
        role,
        target_type: "pcb_port",
        pcb_port_id: portId,
        layer,
        label: role.replaceAll("_", " "),
      }),
    )
  }
  for (const excitation of excitations) {
    const trace = circuitJson.find(
      (e): e is PcbTrace =>
        e.type === "pcb_trace" && e.pcb_trace_id === excitation.pcb_trace_id,
    )!
    for (const [role, terminal, endpoint] of [
      ["signal_source", excitation.source_port, trace.route[0]],
      ["signal_load", excitation.load_port, trace.route.at(-1)],
    ] as const)
      if (terminal && endpoint?.route_type === "wire")
        portMarker(
          role,
          terminal.signal_pcb_port_id,
          endpoint.layer as CopperLayer,
        )
    for (const [role, contact] of [
      ["return_source", excitation.return_source],
      ["return_sink", excitation.return_sink],
    ] as const)
      if (contact.contact_type === "pcb_port")
        portMarker(role, contact.pcb_port_id, contact.layer as CopperLayer)
    for (const point of trace.route) {
      if (point.route_type !== "via") continue
      const via = circuitJson.find(
        (e) =>
          e.type === "pcb_via" &&
          Math.hypot(e.x - point.x, e.y - point.y) < 1e-6 &&
          e.pcb_trace_id === trace.pcb_trace_id &&
          e.layers.includes(point.from_layer) &&
          e.layers.includes(point.to_layer),
      )
      if (!via || via.type !== "pcb_via") continue
      markers.push(
        simulation_pcb_return_current_marker.parse({
          type: "simulation_pcb_return_current_marker",
          simulation_pcb_return_current_marker_id: id(
            "simulation_pcb_return_current_marker",
          ),
          simulation_pcb_return_current_result_id: resultId,
          role: "signal_transition",
          target_type: "pcb_via",
          pcb_via_id: via.pcb_via_id,
          from_layer: point.from_layer,
          to_layer: point.to_layer,
          label: `signal via: ${point.from_layer} ↔ ${point.to_layer}`,
        }),
      )
    }
  }
  return markers
}

/** Export actual sampled values to official circuit-json, retaining every
 * original board/definition element. Reruns replace only results at this
 * experiment + frequency, and their field/heatmap/marker descendants.
 */
export function exportReturnCurrentCircuitJson(options: {
  circuitJson: ReturnCurrentCircuitJson
  experimentId: string
  resultId?: string
  simulation:
    | SimulationResult
    | { model: PalaceModel; reference: PalaceReference }
  fieldFormat?: "gzip" | "json"
}): ReturnCurrentCircuitJson {
  const selected = selectReturnCurrentExperiment(options)
  const backendExcitations =
    "reference" in options.simulation
      ? options.simulation.model.geometry.excitations
      : options.simulation.geometry.excitations
  if (
    backendExcitations.length !== selected.excitations.length ||
    backendExcitations.some(
      (e, i) =>
        JSON.stringify(simulation_return_current_excitation.parse(e)) !==
        JSON.stringify(selected.excitations[i]),
    )
  )
    throw new Error(
      "Result is stale: selected excitation current, contacts, or terminal metadata changed",
    )
  const resultId =
    options.resultId ?? id("simulation_pcb_return_current_result")
  const frequencyHz =
    "reference" in options.simulation
      ? options.simulation.reference.frequencyHz
      : undefined
  const oldIds = new Set(
    options.circuitJson.flatMap((e) =>
      e.type === "simulation_pcb_return_current_result" &&
      e.simulation_experiment_id === options.experimentId &&
      e.frequency_hz === frequencyHz
        ? [e.simulation_pcb_return_current_result_id]
        : [],
    ),
  )
  if (
    options.circuitJson.some(
      (e) =>
        e.type === "simulation_pcb_return_current_result" &&
        e.simulation_pcb_return_current_result_id === resultId &&
        !oldIds.has(resultId),
    )
  )
    throw new Error(
      `Result ID ${resultId} belongs to another experiment/frequency`,
    )
  const circuitJson = options.circuitJson.filter((e) =>
    e.type === "simulation_pcb_return_current_result"
      ? !oldIds.has(e.simulation_pcb_return_current_result_id)
      : "simulation_pcb_return_current_result_id" in e
        ? !oldIds.has(String(e.simulation_pcb_return_current_result_id))
        : true,
  )
  const board = circuitJson.find((e) => e.type === "pcb_board")!
  if (board.type !== "pcb_board") throw new Error("Missing PCB board")
  const fieldId = id("simulation_pcb_return_current_field")
  let grid: SimulationReturnCurrentGridJson
  let metadata: Omit<
    SimulationPcbReturnCurrentField,
    | "field_asset"
    | "type"
    | "simulation_pcb_return_current_field_id"
    | "simulation_pcb_return_current_result_id"
    | "data_format"
  >
  if ("reference" in options.simulation) {
    const { model, reference } = options.simulation
    validatePalaceReference(reference)
    if (reference.columns * reference.rows > 1_000_000)
      throw new Error("The result grid exceeds 1,000,000 cells")
    if (reference.frequencyHz !== model.frequencyHz)
      throw new Error("Palace model/reference frequencies differ")
    if (reference.copperModel !== model.copperModel)
      throw new Error("Palace model/reference copper models differ")
    if (reference.copperThickness !== model.copperThickness)
      throw new Error("Palace model/reference copper thicknesses differ")
    if (
      model.geometry.excitations
        .map((e) => e.simulation_return_current_excitation_id)
        .join() !==
      selected.excitations
        .map((e) => e.simulation_return_current_excitation_id)
        .join()
    )
      throw new Error(
        "Palace model does not contain exactly the selected experiment excitations",
      )
    if (
      reference.provenance.geometrySignature !==
      palaceGeometrySignature(model.geometry)
    )
      throw new Error(
        "Palace reference provenance does not match its model geometry",
      )
    const expected = createPalaceModel({
      circuitJson: selected.solverCircuitJson,
      excitations: selected.excitations,
      frequencyHz: model.frequencyHz,
      stackup: fabricationStackup(model),
      region: model.multilayer?.region,
      sampleLayer: reference.sampleLayer ?? "bottom",
      viaClearance: model.multilayer?.viaClearance,
      ...(model.multilayer
        ? {}
        : {
            layerSeparation: model.layerSeparation,
            copperThickness: model.copperThickness,
          }),
      copperConductivity: model.copperConductivity,
      substratePermittivity: model.substratePermittivity,
      substrateLossTangent: model.substrateLossTangent,
      portResistance: model.portResistance,
      portWidth: model.portWidth,
      meshSize: model.meshSize,
      copperModel: model.copperModel,
      airPadding: model.airPadding,
      order: model.order,
    })
    if (
      palaceGeometrySignature(expected.geometry) !==
      palaceGeometrySignature(model.geometry)
    )
      throw new Error(
        "Palace result is stale: input geometry, current, contacts, or termination changed",
      )
    const minX = Math.min(...model.geometry.boardOutline.map((p) => p.x))
    const minY = Math.min(...model.geometry.boardOutline.map((p) => p.y))
    metadata = {
      layer: reference.sampleLayer ?? "bottom",
      source_net_id: selected.excitations[0].ground_source_net_id,
      field_type: "complex_phasor",
      min_x: minX,
      min_y: minY,
      columns: reference.columns,
      rows: reference.rows,
      cell_width: reference.cellWidth,
      cell_height: reference.cellHeight,
      copper_thickness: reference.copperThickness,
    }
    const blank = () =>
      Array<number | null>(reference.columns * reference.rows).fill(null)
    grid = {
      field_type: "complex_phasor",
      sheet_current_x_real: blank(),
      sheet_current_x_imag: blank(),
      sheet_current_y_real: blank(),
      sheet_current_y_imag: blank(),
    }
    const seen = new Set<number>()
    const containsCopper = createSampleMask(model.geometry)
    for (const sample of reference.samples) {
      const column = Math.round((sample.x - minX) / reference.cellWidth - 0.5)
      const row = Math.round((sample.y - minY) / reference.cellHeight - 0.5)
      if (
        column < 0 ||
        column >= reference.columns ||
        row < 0 ||
        row >= reference.rows ||
        Math.abs(sample.x - (minX + (column + 0.5) * reference.cellWidth)) >
          1e-6 ||
        Math.abs(sample.y - (minY + (row + 0.5) * reference.cellHeight)) > 1e-6
      )
        throw new Error("Palace sample is not aligned with its declared grid")
      const index = row * reference.columns + column
      if (!containsCopper(sample))
        throw new Error(
          "Palace sample lies outside the reference conductor mask",
        )
      if (seen.has(index)) throw new Error("Duplicate Palace grid cell")
      seen.add(index)
      grid.sheet_current_x_real[index] = sample.sheetCurrentXReal
      grid.sheet_current_x_imag[index] = sample.sheetCurrentXImag
      grid.sheet_current_y_real[index] = sample.sheetCurrentYReal
      grid.sheet_current_y_imag[index] = sample.sheetCurrentYImag
    }
    for (let row = 0; row < reference.rows; row++)
      for (let column = 0; column < reference.columns; column++)
        if (
          containsCopper({
            x: minX + (column + 0.5) * reference.cellWidth,
            y: minY + (row + 0.5) * reference.cellHeight,
          }) !== seen.has(row * reference.columns + column)
        )
          throw new Error(
            "Palace samples do not cover exactly the declared conductor mask",
          )
  } else {
    const result = options.simulation
    if (!result.diagnostics.converged)
      throw new Error("Cannot export an unconverged approximation")
    if (result.columns * result.rows > 1_000_000)
      throw new Error("The result grid exceeds 1,000,000 cells")
    if (
      result.geometry.excitations
        .map((e) => e.simulation_return_current_excitation_id)
        .join() !==
      selected.excitations
        .map((e) => e.simulation_return_current_excitation_id)
        .join()
    )
      throw new Error(
        "Approximation does not contain exactly the selected experiment excitations",
      )
    const expected = readGeometry({
      circuitJson: selected.solverCircuitJson,
      excitations: selected.excitations,
    })
    if (
      palaceGeometrySignature(expected) !==
      palaceGeometrySignature(result.geometry)
    )
      throw new Error(
        "Approximation result is stale: input geometry, current, contacts, or termination changed",
      )
    metadata = {
      layer: "bottom",
      source_net_id: selected.excitations[0].ground_source_net_id,
      field_type: "real",
      min_x: result.bounds.minX,
      min_y: result.bounds.minY,
      columns: result.columns,
      rows: result.rows,
      cell_width: result.cellWidth,
      cell_height: result.cellHeight,
      copper_thickness: result.copperThickness,
    }
    grid = {
      field_type: "real",
      sheet_current_x: Array<number | null>(result.columns * result.rows).fill(
        null,
      ),
      sheet_current_y: Array<number | null>(result.columns * result.rows).fill(
        null,
      ),
    }
    const seen = new Set<number>()
    for (const node of result.nodes) {
      const index = node.row * result.columns + node.column
      if (
        !Number.isInteger(node.column) ||
        !Number.isInteger(node.row) ||
        node.column < 0 ||
        node.column >= result.columns ||
        node.row < 0 ||
        node.row >= result.rows ||
        seen.has(index)
      )
        throw new Error("Invalid approximation grid node")
      seen.add(index)
      grid.sheet_current_x[index] = node.sheetCurrentX
      grid.sheet_current_y[index] = node.sheetCurrentY
    }
  }
  getSimulationReturnCurrentGridJsonSchema(metadata).parse(grid)
  const format = options.fieldFormat ?? "gzip"
  if (format !== "gzip" && format !== "json")
    throw new Error("fieldFormat must be gzip or json")
  const mime = format === "gzip" ? "application/gzip" : "application/json"
  const bytes = Buffer.from(JSON.stringify(grid))
  const assetBytes = format === "gzip" ? gzipSync(bytes) : bytes
  const field = simulation_pcb_return_current_field.parse({
    ...metadata,
    type: "simulation_pcb_return_current_field",
    simulation_pcb_return_current_field_id: fieldId,
    simulation_pcb_return_current_result_id: resultId,
    data_format: "simulation_return_current_grid_json_v1",
    field_asset: {
      project_relative_path: `simulation/${fieldId}.json${format === "gzip" ? ".gz" : ""}`,
      mimetype: mime,
      url: `data:${mime};base64,${assetBytes.toString("base64")}`,
    },
  })
  const maxX = metadata.min_x + metadata.columns * metadata.cell_width
  const maxY = metadata.min_y + metadata.rows * metadata.cell_height
  const magnitudes = Array.from(
    { length: metadata.columns * metadata.rows },
    (_, index) => {
      if (grid.field_type === "real")
        return grid.sheet_current_x[index] === null
          ? null
          : Math.hypot(
              grid.sheet_current_x[index]!,
              grid.sheet_current_y[index]!,
            ) / metadata.copper_thickness
      return grid.sheet_current_x_real[index] === null
        ? null
        : Math.hypot(
            grid.sheet_current_x_real[index]!,
            grid.sheet_current_x_imag[index]!,
            grid.sheet_current_y_real[index]!,
            grid.sheet_current_y_imag[index]!,
          ) / metadata.copper_thickness
    },
  )
  const maximum = magnitudes.reduce<number>(
    (max, value) => Math.max(max, value ?? 0),
    0,
  )
  const rectangles = magnitudes
    .flatMap((magnitude, index) =>
      magnitude === null
        ? []
        : [
            `<rect x="${index % metadata.columns}" y="${metadata.rows - 1 - Math.floor(index / metadata.columns)}" width="1" height="1" fill="${currentColor(maximum > 0 ? magnitude / maximum : 0)}"/>`,
          ],
    )
    .join("")
  // Raster is field-only, transparent in voids, with +Y-up grid reversed into
  // top-left image rows. Renderer can choose its own scale from the field data.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${metadata.columns}" height="${metadata.rows}" viewBox="0 0 ${metadata.columns} ${metadata.rows}">${rectangles}</svg>`
  const png = new Resvg(svg).render().asPng()
  const heatmapId = id("simulation_pcb_return_current_heatmap")
  const heatmap = simulation_pcb_return_current_heatmap.parse({
    type: "simulation_pcb_return_current_heatmap",
    simulation_pcb_return_current_heatmap_id: heatmapId,
    simulation_pcb_return_current_result_id: resultId,
    layer: metadata.layer,
    source_net_id: metadata.source_net_id,
    min_x: metadata.min_x,
    min_y: metadata.min_y,
    max_x: maxX,
    max_y: maxY,
    image_asset: {
      project_relative_path: `simulation/${heatmapId}.png`,
      mimetype: "image/png",
      url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
    },
  })
  const result = simulation_pcb_return_current_result.parse({
    type: "simulation_pcb_return_current_result",
    simulation_pcb_return_current_result_id: resultId,
    simulation_experiment_id: options.experimentId,
    pcb_board_id: board.pcb_board_id,
    simulation_return_current_excitation_ids: selected.excitations.map(
      (e) => e.simulation_return_current_excitation_id,
    ),
    ...(frequencyHz === undefined ? {} : { frequency_hz: frequencyHz }),
  })
  return [
    ...circuitJson,
    result,
    field,
    heatmap,
    ...markersFor(selected.solverCircuitJson, selected.excitations, resultId),
  ]
}

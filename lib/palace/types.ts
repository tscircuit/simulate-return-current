import type {
  CopperLayer,
  FabricationStackup,
  PhysicalStackup,
} from "./stackup"
import type { CopperRegion, SignalSegment } from "../types"
import type { Point } from "circuit-json"
import type { SimulationGeometry, SimulationOptions } from "../types"

export interface PalaceOptions
  extends Pick<
    SimulationOptions,
    "circuitJson" | "excitations" | "layerSeparation" | "copperThickness"
  > {
  /** Required; peak phasors use exp(+jωt). No frequency is inferred. */
  frequencyHz: number
  /** Required on boards with more than two copper layers. */
  stackup?: FabricationStackup
  /** Explicit local approximation: cut all copper/dielectrics at this rectangle. */
  region?: { minX: number; minY: number; maxX: number; maxY: number }
  /** Reference-net copper layer to sample; default bottom. */
  sampleLayer?: CopperLayer
  /** Radial clearance from foreign-net via pads; default board clearance or 0.2 mm. */
  viaClearance?: number
  /** Relative permittivity of the substrate; default 4.3. */
  substratePermittivity?: number
  substrateLossTangent?: number
  copperConductivity?: number
  /** Source and load termination resistance in ohms; default 50. */
  portResistance?: number
  portWidth?: number
  meshSize?: number
  airPadding?: number
  order?: 1 | 2
  /** Finite-conductivity boundary approximation for sufficiently thick foils and via walls. Default
   * volumetric_copper resolves conduction inside meshed copper. */
  copperModel?: "volumetric_copper" | "surface_impedance_copper"
}

export interface PalaceModel {
  schemaVersion: 1
  multilayer?: PalaceLayeredGeometry
  geometry: SimulationGeometry
  topPads: Point[][]
  /** Ground pads with a modeled, concentric top-to-bottom ground via. */
  topGroundPads?: Point[][]
  groundVias?: {
    x: number
    y: number
    holeDiameter: number
    outerDiameter: number
    platingThickness: number
  }[]
  /** Source then load for each excitation; absent in legacy saved models. */
  ports?: PalaceTerminalPort[]
  frequencyHz: number
  layerSeparation: number
  copperThickness: number
  copperConductivity: number
  substratePermittivity: number
  substrateLossTangent: number
  portResistance: number
  portWidth: number
  meshSize: number
  airPadding: number
  order: 1 | 2
  copperModel: "volumetric_copper" | "surface_impedance_copper"
  surfaceImpedance?: {
    boundaryModel: "half_space"
    skinDepthMm: number
    minimumThicknessToSkinDepth: number
    currentSampling: "sum_foil_face_surface_currents"
  }
}

export interface PalaceTerminalPort {
  signal: Point
  reference: Point
  referenceLayer: CopperLayer
  signalLayer?: CopperLayer
  signalZ?: number
  referenceZ?: number
  resistance: number
  signalPcbPortId?: string
  referencePcbPortId?: string
}

export interface PalaceSample extends Point {
  /** Integrated-through-thickness sheet current in A/mm, complex peak phasor. */
  sheetCurrentXReal: number
  sheetCurrentYReal: number
  sheetCurrentXImag: number
  sheetCurrentYImag: number
}

export interface PalaceReference {
  schemaVersion: 1
  sampleLayer?: CopperLayer
  solver: "palace"
  solverVersion: string
  femOrder: 1 | 2
  frequencyHz: number
  copperModel: "volumetric_copper" | "surface_impedance_copper"
  surfaceCurrentScaleAmpsPerMm?: number
  samplingMethod?: "sum_foil_face_surface_currents"
  copperThickness: number
  layerSeparation: number
  cellWidth: number
  cellHeight: number
  columns: number
  rows: number
  samples: PalaceSample[]
  sourceCurrents: { real: number; imag: number }[]
  loadCurrents: { real: number; imag: number }[]
  /** Palace v0.14.0 ParaView E fields are nondimensional. */
  electricFieldScaleVoltsPerMeter: number
  normalizationConditionNumber: number
  provenance: {
    geometrySignature: string
    circuitSha256: string
    modelSha256: string
    meshSha256: string
  }
}

/** All physical copper is retained, including unexcited and floating nets. */
export interface PalaceLayeredGeometry {
  region?: { minX: number; minY: number; maxX: number; maxY: number }
  stackup: PhysicalStackup
  sampleLayer: CopperLayer
  referenceNetId: string
  viaClearance: number
  copper: {
    layer: CopperLayer
    netId: string
    regions: CopperRegion[]
    segments: SignalSegment[]
  }[]
  drills: { hole: Point[]; zMin: number; zMax: number }[]
  barrels: {
    netId: string
    hole: Point[]
    outer: Point[]
    clearance?: Point[]
    pads: Point[]
    layers: CopperLayer[]
    zMin: number
    zMax: number
    platingThickness: number
  }[]
  boardCutouts: Point[][]
  audit: {
    traces: number
    vias: number
    pads: number
    platedHoles: number
    unplatedHoles: number
    pours: number
    omittedCopperElements: number
    warnings: string[]
  }
}

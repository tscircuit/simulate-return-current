import { expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import { resolve } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  createPalaceModel,
  renderPalaceModelSvg,
  validatePalaceReference,
  withNamedExcitations,
} from "lib/index"
import type { PalaceReference } from "lib/index"
import { ExplicitPortBoard } from "tests/fixtures/ExplicitPortBoard"

const python = process.env.PALACE_MESH_PYTHON
test.skipIf(!python)(
  "surface sampler preserves complex face signs, physical masks and float32 planes",
  async () => {
    const child = Bun.spawn(
      [python!, resolve(import.meta.dir, "surface-sampler.py")],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0)
      throw new Error(`Surface sampler failed: ${stdout}\n${stderr}`)
    expect(JSON.parse(stdout)).toEqual({
      bothFaceSum: true,
      oneFaceContact: true,
      float32Plane: true,
      noExtrapolation: true,
    })
  },
)

async function input() {
  const circuit = new Circuit()
  circuit.add(<ExplicitPortBoard />)
  await circuit.renderUntilSettled()
  return withNamedExcitations({
    circuitJson: circuit.getCircuitJson(),
    groundNet: "GND",
    ports: [
      {
        source: "U1.OUT",
        sourceReference: "U1.GND",
        load: "U2.IN",
        loadReference: "U2.GND",
        current: "5mA",
        sourceImpedance: 25,
        loadImpedance: 100,
      },
    ],
  })
}

test("surface impedance is explicit, retains 35µm foil/barrels and enforces its skin-depth regime", async () => {
  const circuitJson = await input()
  const volume = createPalaceModel({ circuitJson, frequencyHz: 1e6 })
  const surface = createPalaceModel({
    circuitJson,
    frequencyHz: 1e8,
    copperModel: "surface_impedance_copper",
  })
  expect(surface.geometry).toEqual(volume.geometry)
  expect(surface.topPads).toEqual(volume.topPads)
  expect(surface.groundVias).toEqual(volume.groundVias)
  expect(surface.ports).toEqual(volume.ports)
  expect(surface.copperThickness).toBe(0.035)
  expect(surface.groundVias?.map((via) => via.platingThickness)).toEqual([
    0.035, 0.035,
  ])
  expect(surface.copperConductivity).toBe(5.8e7)
  expect(surface.surfaceImpedance?.skinDepthMm).toBeCloseTo(0.00660855, 8)
  expect(surface.surfaceImpedance?.minimumThicknessToSkinDepth).toBeGreaterThan(
    5,
  )
  expect(surface.surfaceImpedance?.boundaryModel).toBe("half_space")
  expect(() => createPalaceModel({ circuitJson, frequencyHz: 1e8 })).toThrow(
    "skin depth",
  )
  expect(() =>
    createPalaceModel({
      circuitJson,
      frequencyHz: 1e6,
      copperModel: "surface_impedance_copper",
    }),
  ).toThrow("3 skin depths")
  expect(() =>
    createPalaceModel({
      circuitJson,
      frequencyHz: 1e8,
      copperModel: "surface_impedance_copper",
      stackup: { layers: [] } as never,
    }),
  ).toThrow("Stackup must alternate")
})

test("surface references identify their current units and cannot attach to a volume model", async () => {
  const circuitJson = await input()
  const model = createPalaceModel({
    circuitJson,
    frequencyHz: 1e6,
    order: 1,
    meshSize: 2,
    airPadding: 2,
  })
  const reference: PalaceReference = await Bun.file(
    `${import.meta.dir}/../../examples/palace/explicit-ports-1mhz/reference.json`,
  ).json()
  const surfaceReference: PalaceReference = {
    ...reference,
    copperModel: "surface_impedance_copper",
    samplingMethod: "sum_foil_face_surface_currents",
    surfaceCurrentScaleAmpsPerMm: 0.05152,
  }
  validatePalaceReference(surfaceReference)
  expect(() =>
    validatePalaceReference({
      ...surfaceReference,
      surfaceCurrentScaleAmpsPerMm: 0,
    }),
  ).toThrow("positive A/mm scale")
  expect(() =>
    validatePalaceReference({ ...surfaceReference, samplingMethod: undefined }),
  ).toThrow("face-current sampling")
  expect(() =>
    renderPalaceModelSvg(model, { reference: surfaceReference }),
  ).toThrow("copper model")
})

test("CLI preparation records the explicit surface-impedance mode without solving", async () => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "return-current-surface-cli-"),
  )
  try {
    const circuitJson = await input()
    const file = resolve(directory, "input.json")
    await Bun.write(file, JSON.stringify(circuitJson))
    const child = Bun.spawn(
      [
        Bun.which("bun") ?? "bun",
        resolve(import.meta.dir, "../../cli/index.ts"),
        file,
        "--source",
        "U1.OUT",
        "--source-reference",
        "U1.GND",
        "--load",
        "U2.IN",
        "--load-reference",
        "U2.GND",
        "--ground",
        "GND",
        "--current",
        "5mA",
        "--frequency-hz",
        "100000000",
        "--copper-model",
        "surface_impedance",
        "--cell-size",
        "0.05",
        "--prepare-only",
        "--output",
        resolve(directory, "case"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`CLI failed: ${stdout}\n${stderr}`)
    const model = await Bun.file(resolve(directory, "case/model.json")).json()
    expect(model.copperModel).toBe("surface_impedance_copper")
    expect(model.geometry.excitations[0].current).toBe(0.005)
    const definitions = await Bun.file(
      resolve(directory, "case/circuit-definition.json"),
    ).json()
    expect(
      definitions.some(
        (element: { type: string }) => element.type === "simulation_experiment",
      ),
    ).toBe(true)
    expect(
      definitions.some(
        (element: { type: string }) =>
          element.type === "simulation_pcb_return_current_result",
      ),
    ).toBe(false)
    expect(
      await Bun.file(resolve(directory, "case/reference.json")).exists(),
    ).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

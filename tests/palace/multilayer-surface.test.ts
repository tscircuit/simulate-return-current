import { expect, test } from "bun:test"
import { createPalaceModel } from "lib/palace/create-palace-model"
import { parseReturnCurrentCircuitJson } from "lib/parse-circuit-json"
import { fourLayerStackup } from "tests/fixtures/MultilayerBoard"
import savedBoard from "../../examples/palace/multilayer-inner2-1mhz/circuit.json"

const circuitJson = parseReturnCurrentCircuitJson(savedBoard)
const options = {
  circuitJson,
  stackup: fourLayerStackup,
  frequencyHz: 400e6,
  copperModel: "surface_impedance_copper" as const,
}

test("four-layer surface impedance retains all foils, dielectrics, barrels and real terminals at 400 MHz", () => {
  for (const sampleLayer of ["inner2", "bottom"] as const) {
    const model = createPalaceModel({ ...options, sampleLayer })
    expect(model.multilayer!.stackup.copperLayers.map((l) => l.name)).toEqual([
      "top",
      "inner1",
      "inner2",
      "bottom",
    ])
    expect(
      model.multilayer!.stackup.dielectrics.map((l) => l.dielectricConstant),
    ).toEqual([4.1, 4.42, 4.1])
    expect(model.multilayer!.barrels).toHaveLength(4)
    expect(model.multilayer!.audit.omittedCopperElements).toBe(0)
    expect(model.ports!.map((p) => p.resistance)).toEqual([25, 100])
    expect(model.copperModel).toBe("surface_impedance_copper")
    expect(model.surfaceImpedance!.skinDepthMm).toBeCloseTo(0.003304274655, 10)
    expect(model.surfaceImpedance!.minimumThicknessToSkinDepth).toBeGreaterThan(
      3,
    )
    expect(model.copperThickness).toBeCloseTo(
      sampleLayer === "inner2" ? 0.015 : 0.035,
      10,
    )
  }
})

test("multilayer impedance rejects invalid thickness/frequency regimes instead of removing the physical guard", () => {
  expect(() => createPalaceModel({ ...options, frequencyHz: 1e6 })).toThrow(
    "3 skin depths",
  )
  expect(() => createPalaceModel({ ...options, stackup: undefined })).toThrow(
    "stackup",
  )
  const thinFoil = structuredClone(fourLayerStackup)
  thinFoil.layers[2] = { name: "inner1", copperThicknessMm: 0.001 }
  expect(() => createPalaceModel({ ...options, stackup: thinFoil })).toThrow(
    "3 skin depths",
  )
  expect(() =>
    createPalaceModel({ ...options, copperModel: "volumetric_copper" }),
  ).toThrow("skin depth")
  // Via walls are 0.025 mm, thinner than these 0.1 mm foils: they set the limit.
  const thickFoils = structuredClone(fourLayerStackup)
  for (const layer of thickFoils.layers)
    if ("copperThicknessMm" in layer) layer.copperThicknessMm = 0.1
  expect(() =>
    createPalaceModel({ ...options, stackup: thickFoils, frequencyHz: 10e6 }),
  ).toThrow("via-wall")
})

const python = process.env.PALACE_MESH_PYTHON
test.skipIf(!python)(
  "four-layer impedance mesh retains every dielectric and excludes copper volumes",
  async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import(
      "node:fs/promises"
    )
    const { tmpdir } = await import("node:os")
    const { join, resolve } = await import("node:path")
    const directory = await mkdtemp(join(tmpdir(), "multilayer-surface-"))
    try {
      const model = createPalaceModel({
        ...options,
        sampleLayer: "inner2",
        meshSize: 2,
        airPadding: 2,
        order: 1,
      })
      await writeFile(join(directory, "model.json"), JSON.stringify(model))
      const child = Bun.spawn(
        [
          python!,
          resolve("lib/palace/python/mesh.py"),
          join(directory, "model.json"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0)
        throw new Error(`Mesh failed: ${stdout.slice(-2000)}\n${stderr}`)
      const config = JSON.parse(
        await readFile(join(directory, "palace.json"), "utf8"),
      )
      expect(
        config.Domains.Materials.map(
          (m: { Attributes: number[] }) => m.Attributes[0],
        ),
      ).toEqual([1, 105, 103, 101])
      expect(
        config.Domains.Materials.slice(1).map(
          (m: { Permittivity: number }) => m.Permittivity,
        ),
      ).toEqual([4.1, 4.42, 4.1])
      expect(
        config.Boundaries.Conductivity.flatMap(
          (b: { Attributes: number[] }) => b.Attributes,
        ),
      ).toEqual([11, 12])
      const summary = JSON.parse(
        await readFile(join(directory, "mesh-summary.json"), "utf8"),
      )
      expect(summary.minimumSicn).toBeGreaterThan(0)
      expect(summary.copperVolumeMm3).toBeGreaterThan(2)
      expect(summary.portAttributes).toEqual([21, 22])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  240000,
)

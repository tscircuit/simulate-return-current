import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createPalaceModel } from "lib/palace/create-palace-model"
import { parseReturnCurrentCircuitJson } from "lib/parse-circuit-json"
import { fourLayerStackup } from "tests/fixtures/MultilayerBoard"
import savedBoard from "../../examples/palace/multilayer-inner2-1mhz/circuit.json"

const circuitJson = parseReturnCurrentCircuitJson(savedBoard)
const region = { minX: -3, minY: -1, maxX: 3, maxY: 2.5 }
const options = {
  circuitJson,
  stackup: fourLayerStackup,
  frequencyHz: 400e6,
  copperModel: "surface_impedance_copper" as const,
  sampleLayer: "inner2" as const,
}

test("crop changes the physical model and sampling bounds without changing original PCB geometry", () => {
  const full = createPalaceModel(options)
  const crop = createPalaceModel({ ...options, region })
  expect(crop.geometry.board).toEqual(full.geometry.board)
  expect(crop.geometry.boardOutline).toEqual([
    { x: -3, y: -1 },
    { x: 3, y: -1 },
    { x: 3, y: 2.5 },
    { x: -3, y: 2.5 },
  ])
  expect(crop.geometry.physicalModelSignature).not.toEqual(
    full.geometry.physicalModelSignature,
  )
  expect(crop.multilayer!.audit.warnings.join(" ")).toContain(
    "Local-region approximation",
  )
  expect(crop.multilayer!.copper.map((g) => [g.layer, g.netId])).toEqual(
    full.multilayer!.copper.map((g) => [g.layer, g.netId]),
  )
  for (const invalid of [
    { ...region, maxX: 1 },
    { ...region, maxY: 1 },
    { ...region, minX: -5 },
    { ...region, maxX: NaN },
  ])
    expect(() => createPalaceModel({ ...options, region: invalid })).toThrow()
})

test("standalone via route records retain real barrels and reject missing physical vias", () => {
  const via = circuitJson.find((e) => e.type === "pcb_via" && e.pcb_trace_id)!
  if (via.type !== "pcb_via") throw new Error("fixture via missing")
  const record = {
    type: "pcb_trace" as const,
    pcb_trace_id: "via_record",
    source_trace_id: "source_trace_0",
    route: [
      {
        route_type: "via" as const,
        x: via.x,
        y: via.y,
        from_layer: via.from_layer!,
        to_layer: via.to_layer!,
      },
    ],
  }
  const withMarker = [...circuitJson, record]
  expect(
    createPalaceModel({ ...options, circuitJson: withMarker }).multilayer!
      .barrels.length,
  ).toBeGreaterThan(0)
  expect(() =>
    createPalaceModel({
      ...options,
      circuitJson: withMarker.filter((e) => e !== via),
    }),
  ).toThrow("physical pcb_via")
})

const python = process.env.PALACE_MESH_PYTHON
test.skipIf(!python)(
  "Python clips every net to the region and keeps a physical ground path",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-region-"))
    try {
      await writeFile(
        join(dir, "model.json"),
        JSON.stringify(createPalaceModel({ ...options, region })),
      )
      const script = `import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom mesh_multilayer import layer_copper,validate_reference_connectivity\nm=json.load(open(sys.argv[2]))\nb,c=layer_copper(m)\nassert abs(b.area-21)<1e-8\nassert all(b.buffer(1e-6).covers(s) for nets in c.values() for s in nets.values())\nvalidate_reference_connectivity(m,c)\n`
      const child = Bun.spawn(
        [
          python!,
          "-c",
          script,
          resolve("lib/palace/python"),
          join(dir, "model.json"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [err, code] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(err).toBe("")
      expect(code).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)

import { expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import {
  createPalaceModel,
  withNamedExcitations,
  parseReturnCurrentCircuitJson,
  simulateReturnCurrent,
} from "lib/index"
import {
  multilayerModel,
  multilayerCircuit,
} from "tests/fixtures/renderMultilayerBoard"
import { palaceGeometrySignature } from "lib/palace/geometry-signature"
import {
  MultilayerBoard,
  fourLayerStackup,
} from "tests/fixtures/MultilayerBoard"

test("four-layer TSX retains inner routing, blind signal barrels, ground through vias and individual dielectric materials", async () => {
  const { model, circuitJson } = await multilayerModel()
  expect(model.multilayer!.stackup.copperLayers.map((l) => l.name)).toEqual([
    "top",
    "inner1",
    "inner2",
    "bottom",
  ])
  expect(model.multilayer!.stackup.physicalThicknessMm).toBeCloseTo(0.975, 12)
  expect(model.copperThickness).toBeCloseTo(0.015, 12)
  expect(
    model.multilayer!.stackup.dielectrics.map((l) => l.dielectricConstant),
  ).toEqual([4.1, 4.42, 4.1])
  const signals = model.multilayer!.barrels.filter(
    (b) => b.netId !== model.multilayer!.referenceNetId,
  )
  expect(signals).toHaveLength(2)
  expect(
    signals.every(
      (b) =>
        b.layers.join(",") === "top,inner1" ||
        b.layers.join(",") === "inner1,top",
    ),
  ).toBe(true)
  expect(signals.every((b) => b.zMin > 0.5)).toBe(true)
  expect(model.multilayer!.audit).toMatchObject({
    vias: 4,
    traces: 1,
    pads: 4,
    omittedCopperElements: 0,
  })
  expect(
    model.geometry.signals[0].route
      .filter((p) => p.route_type === "wire")
      .map((p) => p.layer),
  ).toContain("inner1")
  expect(model.ports!.map((p) => p.resistance)).toEqual([25, 100])
  expect(model.geometry.cutouts).toHaveLength(4) // Ground drills and their plated walls; blind signal drills stop above inner2.
  expect(() => simulateReturnCurrent({ circuitJson })).toThrow("require Palace")
})

test("physical stackup and sampled layer affect reference provenance; nominal thickness is not used to rescale copper spacing", async () => {
  const { model, circuitJson } = await multilayerModel()
  const changed = createPalaceModel({
    circuitJson,
    stackup: { ...fourLayerStackup, nominalBoardThicknessMm: 1.6 },
    sampleLayer: "bottom",
    frequencyHz: 1e6,
  })
  expect(changed.multilayer!.stackup.physicalThicknessMm).toBeCloseTo(0.975, 12)
  expect(
    changed.multilayer!.audit.warnings.some((s) =>
      s.includes("without scaling"),
    ),
  ).toBe(true)
  expect(palaceGeometrySignature(changed.geometry)).not.toBe(
    palaceGeometrySignature(model.geometry),
  )
  expect(() => createPalaceModel({ circuitJson, frequencyHz: 1e6 })).toThrow(
    "stackup",
  )
  expect(() =>
    createPalaceModel({
      circuitJson,
      stackup: fourLayerStackup,
      sampleLayer: "inner3",
      frequencyHz: 1e6,
    }),
  ).toThrow("absent")
  expect(() =>
    createPalaceModel({
      circuitJson,
      stackup: { layers: fourLayerStackup.layers.slice(1) },
      frequencyHz: 1e6,
    }),
  ).toThrow("alternate")
  expect(() =>
    createPalaceModel({
      circuitJson,
      stackup: fourLayerStackup,
      frequencyHz: 1e9,
    }),
  ).toThrow("skin depth")
  expect(() =>
    createPalaceModel({
      circuitJson: circuitJson.filter(
        (e) => e.type !== "pcb_via" || !e.pcb_trace_id,
      ),
      stackup: fourLayerStackup,
      frequencyHz: 1e6,
    }),
  ).toThrow("physical pcb_via")
})

test("named excitation reversal reverses via transitions and reference-net planes are never invented", async () => {
  const circuitJson = await multilayerCircuit()
  const reversed = withNamedExcitations({
    circuitJson,
    groundNet: "GND",
    ports: [{ source: "U2.IN", load: "U1.OUT", current: "0.1A" }],
  })
  const model = createPalaceModel({
    circuitJson: reversed,
    stackup: fourLayerStackup,
    frequencyHz: 1e6,
  })
  expect(model.geometry.signals[0].route[0]).toMatchObject({
    x: 2,
    layer: "top",
  })
  expect(model.geometry.excitations[0].current).toBe(0.1)
  expect(model.ports![0].signalZ).toBeGreaterThan(model.ports![0].referenceZ!)
  expect(() =>
    createPalaceModel({
      circuitJson: reversed.filter(
        (e) => e.type !== "pcb_copper_pour" || e.layer !== "inner2",
      ),
      stackup: fourLayerStackup,
      sampleLayer: "inner2",
      frequencyHz: 1e6,
    }),
  ).toThrow("no plane is invented")
})

test("six-layer TSX resolves bottom signal terminals and preserves long plated layer spans", async () => {
  const circuit = new Circuit()
  circuit.add(<MultilayerBoard innerPlane layers={6} sourceLayer="bottom" />)
  await circuit.renderUntilSettled()
  const circuitJson = withNamedExcitations({
    circuitJson: parseReturnCurrentCircuitJson(circuit.getCircuitJson()),
    groundNet: "GND",
    referenceLayer: "inner2",
    ports: [{ source: "U1.OUT", load: "U2.IN", current: "5mA" }],
  })
  const layers: import("lib/index").FabricationStackup["layers"] = [
    { name: "top", copperThicknessMm: 0.035 },
  ]
  for (const name of [
    "inner1",
    "inner2",
    "inner3",
    "inner4",
    "bottom",
  ] as const) {
    layers.push({
      material: "FR4",
      dielectricThicknessMm: 0.15,
      dielectricConstant: 4.1,
    })
    layers.push({ name, copperThicknessMm: name === "bottom" ? 0.035 : 0.015 })
  }
  const model = createPalaceModel({
    circuitJson,
    stackup: { layers },
    sampleLayer: "inner2",
    frequencyHz: 1e6,
  })
  expect(model.multilayer!.stackup.copperLayers).toHaveLength(6)
  expect(model.ports![0]).toMatchObject({
    signalLayer: "bottom",
    referenceLayer: "inner2",
    signalZ: 0,
  })
  expect(model.ports![0].referenceZ).toBeGreaterThan(0)
  expect(
    model.multilayer!.barrels.some(
      (b) =>
        b.netId !== model.multilayer!.referenceNetId && b.layers.length === 5,
    ),
  ).toBe(true)
})

test("named reference pins may be on an inner copper layer", async () => {
  const circuit = new Circuit()
  circuit.add(<MultilayerBoard innerPlane referenceLayer="inner2" />)
  await circuit.renderUntilSettled()
  const circuitJson = withNamedExcitations({
    circuitJson: circuit.getCircuitJson(),
    groundNet: "GND",
    ports: [
      {
        source: "U1.OUT",
        sourceReference: "U1.GND",
        load: "U2.IN",
        loadReference: "U2.GND",
        current: "5mA",
      },
    ],
  })
  const model = createPalaceModel({
    circuitJson,
    stackup: fourLayerStackup,
    sampleLayer: "inner2",
    frequencyHz: 1e6,
  })
  expect(model.ports!.map((p) => p.referenceLayer)).toEqual([
    "inner2",
    "inner2",
  ])
  expect(model.ports![0].referenceZ).toBeCloseTo(0.215, 12)
})

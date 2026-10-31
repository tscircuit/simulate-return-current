import { expect, test } from "bun:test"
import { parseCurrentAmps, parseResistanceOhms } from "lib/index"
import { portNetIds } from "lib/port-connectivity"

test("current units are strict signed peak amperes including scientific notation", () => {
  for (const [input, expected] of [
    ["5mA", 0.005],
    ["0.1A", 0.1],
    ["250uA", 0.00025],
    ["250µA", 0.00025],
    ["250μA", 0.00025],
    ["10nA", 1e-8],
    [" -5 mA ", -0.005],
    ["1e-1A", 0.1],
    ["0", 0],
    [0.25, 0.25],
  ] as const)
    expect(parseCurrentAmps(input)).toBeCloseTo(expected, 12)
  for (const input of [
    "",
    "mA",
    "5MA",
    "5m",
    "5mA junk",
    "Infinity",
    "1e400A",
    "1V",
    Number.NaN,
  ])
    expect(() => parseCurrentAmps(input)).toThrow()
})

test("impedances accept positive real ohms and reject shorts, reactive values and garbage", () => {
  expect(parseResistanceOhms("25mOhm")).toBeCloseTo(0.025, 12)
  expect(parseResistanceOhms("10mΩ")).toBeCloseTo(0.01, 12)
  expect(parseResistanceOhms("50ohm")).toBe(50)
  expect(parseResistanceOhms("50Ohms")).toBe(50)
  expect(parseResistanceOhms("1kΩ")).toBe(1000)
  expect(parseResistanceOhms("2MOhm")).toBe(2e6)
  for (const input of [0, -1, Infinity, "50+j10", "50mA", "", "50ohm junk"])
    expect(() => parseResistanceOhms(input)).toThrow()
})

test("portNetIds traverses internally connected component ports to ground nets", () => {
  const nets = portNetIds(
    [
      {
        type: "source_component",
        source_component_id: "sc_jumper",
        name: "J1",
        ftype: "simple_resistor",
        resistance: 0,
        internally_connected_source_port_ids: [["sp_1", "sp_2"]],
      } as any,
      {
        type: "source_component_internal_connection",
        source_component_internal_connection_id: "scic_1",
        source_component_id: "sc_jumper",
        source_port_ids: ["sp_2", "sp_3"],
      } as any,
      {
        type: "source_trace",
        source_trace_id: "st_gnd",
        connected_source_port_ids: ["sp_3"],
        connected_source_net_ids: ["net_gnd"],
      },
    ],
    "sp_1",
  )
  expect(nets).toEqual(["net_gnd"])
})

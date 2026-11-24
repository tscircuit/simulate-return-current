import { expect, test } from "bun:test"
import { isCopper, segmentInCopper } from "lib/geometry"
import type { SimulationGeometry } from "lib/types"

const board = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

const maskCutout = [
  { x: 2, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 6 },
  { x: 2, y: 6 },
]

const geometry = {
  board: {} as SimulationGeometry["board"],
  boardOutline: board,
  groundRegions: [{ outer: board, holes: [], maskCutouts: [maskCutout] }],
  cutouts: [],
  signals: [],
  segments: [],
  excitations: [],
} as SimulationGeometry

test("isCopper treats mask cutouts as voids", () => {
  expect(isCopper({ x: 3, y: 5 }, geometry)).toBe(false)
  expect(isCopper({ x: 5, y: 5 }, geometry)).toBe(true)
})

test("segmentInCopper splits edges at mask-cutout boundaries", () => {
  // Crosses the mask cutout between x = 2 and x = 4 at y = 5, but the
  // segment midpoint (5, 5) is copper, so midpoint-only sampling misses it.
  expect(
    segmentInCopper({ start: { x: 0, y: 5 }, end: { x: 10, y: 5 } }, geometry),
  ).toBe(false)
  // A segment clear of the mask cutout still passes.
  expect(
    segmentInCopper({ start: { x: 0, y: 2 }, end: { x: 10, y: 2 } }, geometry),
  ).toBe(true)
})

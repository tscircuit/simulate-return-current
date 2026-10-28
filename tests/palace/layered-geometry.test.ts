import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createPalaceModel } from "lib/palace/create-palace-model"
import { parseReturnCurrentCircuitJson } from "lib/parse-circuit-json"
import { fourLayerStackup } from "tests/fixtures/MultilayerBoard"
import savedBoard from "../../examples/palace/multilayer-inner2-1mhz/circuit.json"

const python = process.env.PALACE_MESH_PYTHON
test.skipIf(!python)(
  "layered geometry meshes every dielectric, port aperture and conductor interface from the planar partition",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "layered-geometry-"))
    try {
      for (const variant of ["surface", "cropped", "volume"] as const) {
        const model = createPalaceModel({
          circuitJson: parseReturnCurrentCircuitJson(savedBoard),
          stackup: fourLayerStackup,
          frequencyHz: variant === "volume" ? 1e6 : 400e6,
          copperModel:
            variant === "volume"
              ? "volumetric_copper"
              : "surface_impedance_copper",
          sampleLayer: "inner2",
          ...(variant === "cropped"
            ? { region: { minX: -3, minY: -1, maxX: 3, maxY: 2.5 } }
            : {}),
        })
        const filename = join(directory, "model.json")
        await writeFile(filename, JSON.stringify(model))
        const child = Bun.spawn(
          [python!, resolve("tests/palace/layered-geometry.py"), filename],
          {
            env: { ...process.env, PYTHONPATH: resolve("lib/palace/python") },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        if (code !== 0)
          throw new Error(`${variant}: ${stdout.slice(-2000)}\n${stderr}`)
        const report = JSON.parse(stdout.trim().split("\n").at(-1)!)
        expect(report.minimumSicn).toBeGreaterThan(1e-6)
        expect(report.dielectricAttributes).toEqual([101, 103, 105])
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  240000,
)

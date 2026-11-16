import { palacePython, palacePythonAsset } from "./python-runtime"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createPalaceModel } from "./create-palace-model"
import type { PalaceOptions } from "./types"
import { runCommand } from "./run-command"
import { writeSampleGrid } from "./write-sample-grid"

// Community-built Palace v0.14.0; pinned by digest, not a moving image tag.
export const palaceImage =
  "benvial/palace@sha256:f0f3a3cbbdf1ee2d8f856ddbe1f5bf4628a92ee8ab87d1e27dc33402ad9c8dda"

export type PalaceCaseOptions = PalaceOptions & {
  destination: string
  python?: string
  palaceBin?: string
  cellSize?: number
  processes?: number
}

export async function preparePalaceCase(options: PalaceCaseOptions) {
  const model = createPalaceModel(options)
  const processes =
    options.processes ?? Number(process.env.PALACE_PROCESSES ?? 1)
  if (!Number.isInteger(processes) || processes < 1)
    throw new Error("processes must be a positive integer")

  const destination = resolve(options.destination)
  await mkdir(destination, { recursive: true })
  await writeFile(
    `${destination}/circuit.json`,
    JSON.stringify(options.circuitJson),
  )
  await writeFile(`${destination}/model.json`, JSON.stringify(model, null, 2))
  if (model.multilayer)
    await writeFile(
      `${destination}/model-audit.json`,
      JSON.stringify(model.multilayer.audit, null, 2),
    )
  const grid = await writeSampleGrid({
    destination,
    geometry: model.geometry,
    cellSize: options.cellSize,
  })
  return { model, destination, processes, grid }
}

export async function runPalaceCase(options: PalaceCaseOptions): Promise<void> {
  const { model, destination, processes } = await preparePalaceCase(options)
  const python = palacePython(options.python)
  const meshScript = palacePythonAsset("mesh.py")
  const sampleScript = palacePythonAsset("sample.py")
  console.log(`Meshing ${destination}`)
  await runCommand({
    command: [python, meshScript, `${destination}/model.json`],
    cwd: destination,
    logPath: `${destination}/mesh.log`,
  })
  const palaceBin = options.palaceBin ?? process.env.PALACE_BIN
  const command = palaceBin
    ? [palaceBin, "-np", String(processes), "palace.json"]
    : [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        `type=bind,src=${destination},dst=/case`,
        "--workdir",
        "/case",
        // With OpenBLAS's auto-detected kernels on Intel Xeon 6975P-C runners,
        // SuperLU finds an exactly zero pivot on input that solves on AMD EPYC.
        // Pinning OpenBLAS to its Haswell kernels makes the solve succeed on
        // both CPUs.
        "--env",
        "OPENBLAS_CORETYPE=Haswell",
        palaceImage,
        "palace",
        "-np",
        String(processes),
        "palace.json",
      ]
  console.log(`Running Palace at ${model.frequencyHz} Hz`)
  await runCommand({
    command,
    cwd: destination,
    logPath: `${destination}/palace.log`,
  })
  console.log("Sampling complex conduction current through ground copper")
  await runCommand({
    command: [python, sampleScript, destination],
    cwd: destination,
    logPath: `${destination}/sample.log`,
  })
}

# Four-layer Palace example: inner2

Generated from [`MultilayerBoard.tsx`](../../../tests/fixtures/MultilayerBoard.tsx).
The top signal uses blind vias to reach inner1. Ground through vias connect
inner2 and bottom. The source/load ports use actual top ground pins and
25 Ω/100 Ω real terminations, with a prescribed 5 mA peak source at 1 MHz.

This is a completed Palace v0.14.0 driven Maxwell solve with volumetric copper,
three dielectric slabs (relative permittivity 4.1/4.42/4.1), FEM order 1,
2 mm mesh target and 2 mm air padding. All emitted copper is retained.
`mesh-summary.json` records 9,847 nodes and 54,489 tetrahedra.

The full run at **0.05 mm** sample pitch (160 × 120 candidates) took
**19.39 seconds** on the development machine, including meshing,
two-process Palace, sampling and default image export. `run-timing.json`
records that original run. This directory stores a subsequent **0.2 mm**
resampling (40 × 30 candidates, 1196 copper samples) for compact,
TSX-regenerated visual snapshots. The display scale is 0.2 A/mm².
`resample-timing.json` records reuse of the completed solve.

Reproduce from a checkout with Gmsh/VTK Python and Docker/native Palace:

```sh
PALACE_PYTHON=/path/to/venv/bin/python \
  bun scripts/generate-multilayer-example.tsx work/multilayer-inner2 inner2
```

`reference.json` stores the complex through-thickness sheet current sampled
on **inner2** and the actual source/load currents, with circuit/model/mesh
hashes. `palace.log`, `palace.json`, `port-I.csv` and `normalization.json`
preserve solver configuration and source-normalization evidence.

**Not mesh-convergence certified.** Source current is normalized at the
port; that does not prove sampled plane current-density accuracy. Meshing is
single-threaded and deterministic: regenerating reproduces the same mesh and
bit-identical samples. Before that, two four-thread meshes of the same inputs gave
inner2 sheet currents differing by roughly 45% relative L2 while port currents agreed
to about 1e-4, so the sampled field at this 2 mm target is strongly mesh-dependent.
The multilayer solve uses AMS-preconditioned GMRES at 1e-10, which matches a SuperLU
solve on the same mesh to about 0.1%. These
completed solves are geometry/sampling regression examples, not calibrated
current-density limits or a certified multilayer ground truth. Quantitative
use requires mesh/order refinement and relevant component/package models.

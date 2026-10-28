"""The layered B-rep must mesh every material exactly as the planar partition describes."""
import json
from pathlib import Path
import sys

import gmsh
import numpy as np
from mesh_multilayer import SLIVER_MM, generate_multilayer_mesh, layer_copper, partition_pieces
from shapely.geometry import Polygon

model = json.loads(Path(sys.argv[1]).read_text())
destination = Path(sys.argv[1]).parent
generate_multilayer_mesh(model, destination)
summary = json.loads((destination / "mesh-summary.json").read_text())
assert summary["minimumSicn"] > 1e-6, f"Near-degenerate tetrahedra: {summary['minimumSicn']}"

# Expected dielectric volumes straight from the 2D partition.
board, copper = layer_copper(model)
x0, y0, x1, y1 = board.bounds
pad = model["airPadding"]
box = Polygon([(x0 - pad, y0 - pad), (x1 + pad, y0 - pad), (x1 + pad, y1 + pad), (x0 - pad, y1 + pad)])
expected = {}
for piece in partition_pieces(model, board, copper, box):
    if piece["material"][0] == "dielectric":
        attribute = piece["material"][1]
        expected[attribute] = expected.get(attribute, 0) + piece["shape"].area * (piece["zMax"] - piece["zMin"])

gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)
gmsh.open(str(destination / "mesh.msh"))
tags, coords, _ = gmsh.model.mesh.getNodes()
xyz = np.zeros((int(tags.max()) + 1, 3))
xyz[tags.astype(int)] = coords.reshape(-1, 3)
measured = {}
for dim, tag in gmsh.model.getPhysicalGroups():
    total = 0.0
    for entity in gmsh.model.getEntitiesForPhysicalGroup(dim, tag):
        types, _, nodes = gmsh.model.mesh.getElements(dim, int(entity))
        for element_type, element_nodes in zip(types, nodes):
            if element_type == 4:
                p = xyz[element_nodes.reshape(-1, 4).astype(int)]
                total += np.abs(np.einsum("ij,ij->i", p[:, 1] - p[:, 0],
                                          np.cross(p[:, 2] - p[:, 0], p[:, 3] - p[:, 0]))).sum() / 6
            elif element_type == 2:
                p = xyz[element_nodes.reshape(-1, 3).astype(int)]
                total += np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1).sum() / 2
    measured[(dim, tag)] = total
gmsh.finalize()

for attribute, volume in expected.items():
    assert abs(measured[(3, attribute)] - volume) <= 1e-3 * volume, (attribute, measured[(3, attribute)], volume)
for index, port in enumerate(model["ports"]):
    area = model["portWidth"] * abs(port["signalZ"] - port["referenceZ"])
    if area > 0:
        # Snapping the aperture ends to the grid moves each by at most half a step.
        assert abs(measured[(2, 21 + index)] - area) <= SLIVER_MM * abs(port["signalZ"] - port["referenceZ"]) + 1e-3 * area, \
            (index, measured[(2, 21 + index)], area)
groups = {tag for dim, tag in measured if dim == 2}
if model["copperModel"] == "surface_impedance_copper":
    assert {11, 12}.issubset(groups) and (3, 3) not in measured
else:
    assert (3, 3) in measured and measured[(3, 3)] > 0
print(json.dumps({"minimumSicn": summary["minimumSicn"], "tetrahedra": summary["tetrahedra"],
                  "dielectricAttributes": sorted(expected)}))

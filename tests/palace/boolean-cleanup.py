"""Fast deletion of replaced tags must preserve every physical CAD domain."""
import json
from pathlib import Path
import sys
import time

import gmsh
from mesh_multilayer import generate_multilayer_mesh


class CapturedGeometry(Exception):
    pass


model = json.loads(Path(sys.argv[1]).read_text())
set_number = gmsh.option.setNumber
snapshots = []
durations = []

for cleanup in [1, 2]:
    # Run the production pipeline twice, retaining the old cleanup as a control.
    def option(name, value):
        set_number(name, cleanup if name == "Geometry.OCCFastUnbind" and value == 2 else value)

    def capture(_dimension):
        groups = {}
        for dim, tag in gmsh.model.getPhysicalGroups():
            entities = []
            for entity in gmsh.model.getEntitiesForPhysicalGroup(dim, tag):
                mass = gmsh.model.occ.getMass(dim, int(entity))
                center = gmsh.model.occ.getCenterOfMass(dim, int(entity))
                bounds = gmsh.model.occ.getBoundingBox(dim, int(entity))
                entities.append(tuple(round(v, 8) for v in (mass, *center, *bounds)))
            groups[(dim, tag, gmsh.model.getPhysicalName(dim, tag))] = sorted(entities)
        snapshots.append(groups)
        raise CapturedGeometry()

    gmsh.option.setNumber = option
    gmsh.model.mesh.generate = capture
    started = time.monotonic()
    try:
        generate_multilayer_mesh(model, Path(sys.argv[1]).parent)
    except CapturedGeometry:
        pass
    durations.append(time.monotonic() - started)

assert len(snapshots) == 2
assert snapshots[0] == snapshots[1], "Fast cleanup changed material volumes or boundary geometry"
groups = snapshots[1]
assert {105, 103, 101}.issubset({tag for dim, tag, _ in groups if dim == 3})
assert {21, 22}.issubset({tag for dim, tag, _ in groups if dim == 2})
if model["copperModel"] == "surface_impedance_copper":
    assert {11, 12}.issubset({tag for dim, tag, _ in groups if dim == 2})
    assert all(tag != 3 for dim, tag, _ in groups if dim == 3)
else:
    assert any(dim == 3 and tag == 3 for dim, tag, _ in groups)
print(json.dumps({"unchangedPhysicalGroups": len(groups), "safeSeconds": durations[0], "fastSeconds": durations[1]}))

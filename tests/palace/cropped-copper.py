"""A crop can touch a pour without retaining area at every point of contact."""
from copy import deepcopy
from shapely.geometry import Polygon, box
from mesh_multilayer import layer_copper, validate_aperture


def outline(coordinates):
    return [{"x": x, "y": y} for x, y in coordinates]


# The upper arm touches x=0 along a line; only the lower arm has area in the crop.
pour = [(-2, 0), (1, 0), (1, 1), (-1, 1), (-1, 2), (0, 2), (0, 3), (-2, 3)]
raw = Polygon(pour).intersection(box(0, 0, 4, 4))
assert raw.geom_type == "GeometryCollection"
model = {
    "geometry": {"boardOutline": outline([(0, 0), (4, 0), (4, 4), (0, 4)])},
    "multilayer": {
        "region": {"minX": 0, "minY": 0, "maxX": 4, "maxY": 4},
        "boardCutouts": [], "barrels": [], "drills": [],
        "stackup": {"copperLayers": [{"name": "inner1", "zMin": 0, "zMax": 0.1}]},
        "copper": [{"layer": "inner1", "netId": "ground", "segments": [],
                    "regions": [{"outer": outline(pour), "holes": [], "isPlane": True}]}],
    },
}
board, copper = layer_copper(model)
actual = copper["inner1"]["ground"]
assert actual.geom_type == "Polygon"
assert actual.symmetric_difference(box(0, 0, 1, 1)).area == 0
assert actual.area == raw.area
assert not actual.intersects(box(-0.01, 2, 0.01, 3))

# A vertical port ending at the foil surface does not cross the foil volume.
port = {"signalZ": 0.5, "referenceZ": 0.1}
corners = [(0.4, 0.5, 0.5), (0.6, 0.5, 0.5), (0.6, 0.5, 0.1), (0.4, 0.5, 0.1)]
options = {"model": model, "port": port, "corners": corners, "copper": copper, "board": board}
validate_aperture(options)

# An actually intersected foil must still be rejected for vertical (line
# projection) and slanted (polygon projection) ports.
obstructed = deepcopy(model)
obstructed["multilayer"]["stackup"]["copperLayers"][0].update(zMin=0.2, zMax=0.3)
for dx in [0, 0.1]:
    shifted = [(x + (dx if z == 0.1 else 0), y, z) for x, y, z in corners]
    try:
        validate_aperture({**options, "model": obstructed, "corners": shifted})
    except ValueError as error:
        assert "intermediate copper" in str(error)
    else:
        raise AssertionError("Port through copper was accepted")

# Nor may a port cross a real plated barrel.
barrel = deepcopy(model)
barrel["multilayer"]["barrels"] = [{
    "hole": outline([(0.45, 0.45), (0.55, 0.45), (0.55, 0.55), (0.45, 0.55)]),
    "platingThickness": 0.025, "zMin": 0.1, "zMax": 0.5,
}]
try:
    validate_aperture({**options, "model": barrel})
except ValueError as error:
    assert "plated barrel" in str(error)
else:
    raise AssertionError("Port through barrel was accepted")

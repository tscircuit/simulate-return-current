"""Synthetic VTK importer contract test; this is not an EM field fixture."""
import json
from pathlib import Path
import sys
import tempfile
import numpy as np
import vtk
from vtk.util.numpy_support import numpy_to_vtk

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib/palace/python"))
from surface_sample import sample_surface

points = vtk.vtkPoints()  # float32, matching Palace VTK export coordinates
for xyz in [(-1, -1, 0), (1, -1, 0), (-1, 1, 0),
            (-2, -2, -.035), (3, -2, -.035), (-2, 3, -.035)]:
    points.InsertNextPoint(*xyz)
grid = vtk.vtkUnstructuredGrid()
grid.SetPoints(points)
for offset in [0, 3]:
    triangle = vtk.vtkTriangle()
    for index in range(3):
        triangle.GetPointIds().SetId(index, offset + index)
    grid.InsertNextCell(triangle.GetCellType(), triangle.GetPointIds())
for name, values in [("J_s_real", [[2, 3, 0]] * 3 + [[5, -1, 0]] * 3),
                     ("J_s_imag", [[1, -2, 0]] * 3 + [[-3, 4, 0]] * 3)]:
    array = numpy_to_vtk(np.array(values, dtype=float), deep=True)
    array.SetName(name)
    grid.GetPointData().AddArray(array)
attributes = numpy_to_vtk(np.array([11, 11]), deep=True)
attributes.SetName("attribute")
grid.GetCellData().AddArray(attributes)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory)
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(path / "piece.vtu"))
    writer.SetInputData(grid)
    assert writer.Write()
    (path / "data.pvtu").write_text('<VTKFile><PUnstructuredGrid><Piece Source="piece.vtu"/></PUnstructuredGrid></VTKFile>')
    receipts = []
    actual = sample_surface(path / "data.pvtu", np.array([[0, -.5], [.25, .25]]), {"copperThickness": .035}, .002, receipts)
    # First point has both real surfaces, second has only a buried-junction face.
    np.testing.assert_allclose(actual, np.array([[7-2j, 2+2j], [5-3j, -1+4j]]) * .002)
    assert receipts[0]["bothFaces"] == 1 and receipts[0]["oneFace"] == 1
    assert receipts[0]["faces"][1]["validSamples"] == 2
    try:
        sample_surface(path / "data.pvtu", np.array([[10., 10.]]), {"copperThickness": .035}, .002)
    except ValueError as error:
        assert "no exposed foil face" in str(error)
    else:
        raise AssertionError("Never extrapolate absent conductor current")
    # Translate the same two physical faces to an inner foil. A hardcoded
    # bottom-layer sampler would find no triangles and fail this contract.
    for index in range(points.GetNumberOfPoints()):
        x, y, z = points.GetPoint(index)
        points.SetPoint(index, x, y, z + .25)
    points.Modified()
    grid.Modified()
    assert writer.Write()
    inner = {"copperThickness": .035, "multilayer": {"sampleLayer": "inner2", "stackup": {"copperLayers": [{"name": "inner2", "zMin": .215, "zMax": .25}]}}}
    actual = sample_surface(path / "data.pvtu", np.array([[0, -.5], [.25, .25]]), inner, .002)
    np.testing.assert_allclose(actual, np.array([[7-2j, 2+2j], [5-3j, -1+4j]]) * .002)
print(json.dumps({"bothFaceSum": True, "oneFaceContact": True, "float32Plane": True, "noExtrapolation": True}))

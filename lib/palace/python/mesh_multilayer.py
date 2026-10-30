"""Layered copper, dielectric, and plated-hole geometry for the Palace adapter.
This builds physical geometry only; Palace solves Maxwell's equations.
"""
import json
import math
import time
import gmsh
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union, polygonize
from shapely import set_precision, union_all
from shapely.geometry import Point
from shapely.strtree import STRtree
from shapely.geometry.polygon import orient
from mesh import points


def clean(shape):
    return set_precision(shape, grid_size=1e-6)


def nonempty_polygons(shape):
    if shape.is_empty or shape.area <= 1e-12:
        return []
    if shape.geom_type == "Polygon":
        return [shape]
    if shape.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [polygon for part in shape.geoms for polygon in nonempty_polygons(part)]
    raise ValueError("Expected polygonal copper")


def build_layer_copper(model, trace_caps="round"):
    layered = model["multilayer"]
    board = Polygon(points(model["geometry"]["boardOutline"]))
    for cutout in layered["boardCutouts"]:
        board = board.difference(Polygon(points(cutout)))
    if not board.is_valid:
        raise ValueError("Invalid board outline/cutout")
    barrel_shapes = [Polygon(points(barrel["hole"])).buffer(barrel["platingThickness"], join_style="mitre")
                     for barrel in layered["barrels"]]
    barrel_tree = STRtree(barrel_shapes)
    for index, barrel in enumerate(layered["barrels"]):
        outer = barrel_shapes[index]
        for other_index in barrel_tree.query(outer, predicate="intersects"):
            if other_index <= index:
                continue
            other = layered["barrels"][other_index]
            if barrel["netId"] == other["netId"] or min(barrel["zMax"], other["zMax"]) <= max(barrel["zMin"], other["zMin"]):
                continue
            other_outer = barrel_shapes[other_index]
            if outer.intersection(other_outer).intersection(board).area > 1e-10:
                raise ValueError("Different-net plated barrels overlap")
    copper = {}
    for foil in layered["stackup"]["copperLayers"]:
        groups = {}
        for group in layered["copper"]:
            if group["layer"] != foil["name"]:
                continue
            regions, planes = [], []
            for region in group["regions"]:
                shape = Polygon(points(region["outer"]), [points(h) for h in region["holes"]])
                if not shape.is_valid:
                    raise ValueError(f"Invalid copper polygon on {foil['name']} for {group['netId']}")
                (planes if region.get("isPlane") else regions).append(shape)
            strips = [LineString([points([s["start"]])[0], points([s["end"]])[0]])
                      .buffer(s["width"] / 2, quad_segs=8, cap_style=trace_caps, join_style="round")
                      for s in group["segments"]]
            plane = unary_union(planes)
            if not plane.is_empty:
                clearances = unary_union([Polygon(points(barrel["clearance"])) for barrel in layered["barrels"]
                                          if barrel["zMin"] <= foil["zMin"] and barrel["zMax"] >= foil["zMax"]
                                          and group["netId"] != barrel["netId"]])
                plane = plane.difference(clearances)
            groups[group["netId"]] = unary_union([*regions, *strips, plane])
        for barrel in layered["barrels"]:
            if barrel["zMin"] <= foil["zMin"] and barrel["zMax"] >= foil["zMax"]:
                hole = Polygon(points(barrel["hole"]))
                footprint = hole.buffer(barrel["platingThickness"], join_style="mitre").difference(hole)
                if foil["name"] in barrel["layers"]:
                    footprint = unary_union([footprint, Polygon(points(barrel["pads"]))])
                groups[barrel["netId"]] = unary_union([groups.get(barrel["netId"], Polygon()), footprint])
        drilled = unary_union([Polygon(points(drill["hole"])) for drill in layered["drills"]
                               if drill["zMin"] <= foil["zMin"] and drill["zMax"] >= foil["zMax"]])
        for net_id, shape in list(groups.items()):
            shape = shape.difference(drilled)
            if not layered.get("region") and not shape.is_empty and not board.buffer(2e-6).covers(shape):
                raise ValueError(f"Copper for {net_id} on {foil['name']} leaves the PCB")
            # A crop tangent to a copper edge can leave isolated lines/points.
            # They have no copper area or volume and must not enter connectivity
            # or GEOS overlays as mixed-dimensional GeometryCollections.
            groups[net_id] = unary_union(nonempty_polygons(shape.intersection(board)))
        copper[foil["name"]] = groups
    return clean(board), {layer: {net: clean(shape) for net, shape in groups.items()} for layer, groups in copper.items()}


def copper_overlaps(copper):
    """Exact polygon intersections; the spatial index only filters candidates."""
    overlaps = []
    for layer, groups in copper.items():
        names = sorted(groups)
        shapes = [groups[name] for name in names]
        tree = STRtree(shapes)
        for index, shape in enumerate(shapes):
            for other_index in sorted(tree.query(shape, predicate="intersects")):
                if other_index <= index:
                    continue
                overlap = shape.intersection(shapes[other_index])
                if overlap.area > 1e-10:
                    overlaps.append({"layer": layer, "nets": [names[index], names[other_index]],
                                     "areaMm2": overlap.area, "boundsMm": list(overlap.bounds)})
    return overlaps


def layer_copper(model):
    board, copper = build_layer_copper(model)
    overlaps = copper_overlaps(copper)
    if overlaps:
        first = overlaps[0]
        raise ValueError(f"Different nets overlap on {first['layer']}: {', '.join(first['nets'])}; area={first['areaMm2']:.9g} mm², bounds={tuple(first['boundsMm'])}")
    return board, copper



def validate_reference_connectivity(model, copper):
    layered = model["multilayer"]
    reference_net = layered["referenceNetId"]
    board = Polygon(points(model["geometry"]["boardOutline"]))
    for cutout in layered["boardCutouts"]:
        board = board.difference(Polygon(points(cutout)))
    nodes = []
    for foil in layered["stackup"]["copperLayers"]:
        for shape in nonempty_polygons(copper[foil["name"]].get(reference_net, Polygon())):
            nodes.append({"shape": shape, "zMin": foil["zMin"], "zMax": foil["zMax"], "layer": foil["name"]})
    for barrel in layered["barrels"]:
        if barrel["netId"] != reference_net:
            continue
        hole = Polygon(points(barrel["hole"]))
        nodes.append({"shape": hole.buffer(barrel["platingThickness"], join_style="mitre").difference(hole).intersection(board),
                      "zMin": barrel["zMin"], "zMax": barrel["zMax"], "layer": None})
    adjacency = [set() for _ in nodes]
    for index, node in enumerate(nodes):
        for other_index in range(index + 1, len(nodes)):
            other = nodes[other_index]
            if min(node["zMax"], other["zMax"]) < max(node["zMin"], other["zMin"]) - 1e-8:
                continue
            if node["shape"].buffer(2e-6).intersection(other["shape"]).area > 1e-10:
                adjacency[index].add(other_index)
                adjacency[other_index].add(index)
    connected = None
    for port in model["ports"]:
        contact = Point(port["reference"]["x"], port["reference"]["y"])
        candidates = [index for index, node in enumerate(nodes) if node["layer"] == port["referenceLayer"] and Polygon(node["shape"].exterior).buffer(2e-6).covers(contact)]
        if len(candidates) != 1:
            raise ValueError("Reference terminal must identify one physical copper region")
        reached, pending = set(), candidates.copy()
        while pending:
            index = pending.pop()
            if index in reached:
                continue
            reached.add(index)
            pending.extend(adjacency[index] - reached)
        if not any(nodes[index]["layer"] == layered["sampleLayer"] for index in reached):
            raise ValueError("Reference pad is not physically connected to the sampled reference layer; supply real traces/vias")
        if connected is not None and not reached.intersection(connected):
            raise ValueError("Reference terminals are on disconnected copper islands")
        connected = reached


def port_surface(options):
    model, port, neighbor, copper, board = [options[k] for k in ["model", "port", "neighbor", "copper", "board"]]
    signal, reference = port["signal"], port["reference"]
    dx, dy = reference["x"] - signal["x"], reference["y"] - signal["y"]
    if abs(dx) + abs(dy) < 1e-9:
        dx, dy = neighbor["x"] - signal["x"], neighbor["y"] - signal["y"]
    length = (dx * dx + dy * dy) ** 0.5
    if length < 1e-9:
        raise ValueError("Port endpoint needs a nonzero neighboring route segment")
    tx, ty = -dy / length * model["portWidth"] / 2, dx / length * model["portWidth"] / 2
    corners = [(signal["x"] - tx, signal["y"] - ty, port["signalZ"]),
               (signal["x"] + tx, signal["y"] + ty, port["signalZ"]),
               (reference["x"] + tx, reference["y"] + ty, port["referenceZ"]),
               (reference["x"] - tx, reference["y"] - ty, port["referenceZ"])]
    signal_shapes = unary_union(list(copper[port["signalLayer"]].values()))
    reference_shapes = copper[port["referenceLayer"]].get(model["multilayer"]["referenceNetId"], Polygon())
    if not signal_shapes.buffer(2e-6).covers(LineString([c[:2] for c in corners[:2]])):
        raise ValueError("Port aperture leaves signal copper")
    coplanar = abs(port["signalZ"] - port["referenceZ"]) < 1e-9
    reference_contact_shapes = unary_union([Polygon(p.exterior) for p in nonempty_polygons(reference_shapes)]) if coplanar else reference_shapes
    if not reference_contact_shapes.buffer(2e-6).covers(LineString([c[:2] for c in corners[2:]])):
        raise ValueError("Port aperture leaves reference copper; specify a physical reference pin")
    if coplanar:
        patch = Polygon([c[:2] for c in corners]).difference(unary_union([signal_shapes, reference_contact_shapes]))
        if patch.geom_type != "Polygon" or patch.is_empty or len(patch.interiors):
            raise ValueError("Coplanar port needs one clear dielectric gap")
        signal_net = options["signalNetId"]
        intended_signal = copper[port["signalLayer"]][signal_net]
        if patch.boundary.intersection(intended_signal.boundary.buffer(2e-6)).length < model["portWidth"] * 0.9 or patch.boundary.intersection(reference_shapes.boundary.buffer(2e-6)).length < model["portWidth"] * 0.9:
            raise ValueError(f"Coplanar port does not contact both intended conductors: signal={patch.boundary.intersection(intended_signal.boundary.buffer(2e-6)).length}, reference={patch.boundary.intersection(reference_shapes.boundary.buffer(2e-6)).length}, width={model['portWidth']}")
        if not board.covers(patch):
            raise ValueError("Port crosses board cutout/edge")
        return {"kind": "coplanar", "patch": clean(patch), "z": port["signalZ"]}
    validate_aperture({"model": model, "port": port, "corners": corners, "copper": copper, "board": board})
    return {"kind": "quad", "signal": (signal["x"], signal["y"]), "reference": (reference["x"], reference["y"]),
            "halfWidth": (tx, ty), "signalZ": port["signalZ"], "referenceZ": port["referenceZ"]}



def projected_aperture(options):
    port, z_min, z_max, corners = [options[k] for k in ["port", "zMin", "zMax", "corners"]]
    a = max(z_min, min(port["signalZ"], port["referenceZ"]))
    b = min(z_max, max(port["signalZ"], port["referenceZ"]))
    if b - a <= 1e-8:
        return Polygon()
    coordinates = []
    for z in [a, b]:
        fraction = (z - port["signalZ"]) / (port["referenceZ"] - port["signalZ"])
        for source, target in [(corners[0], corners[3]), (corners[1], corners[2])]:
            coordinates.append((source[0] + fraction * (target[0] - source[0]),
                                source[1] + fraction * (target[1] - source[1])))
    from shapely.geometry import MultiPoint
    return MultiPoint(coordinates).convex_hull


def validate_aperture(options):
    model, port, corners, copper, board = [options[k] for k in ["model", "port", "corners", "copper", "board"]]
    from shapely.geometry import MultiPoint
    footprint = MultiPoint([c[:2] for c in corners]).convex_hull
    if not board.buffer(2e-6).covers(footprint):
        raise ValueError("Port aperture crosses a physical PCB cutout/edge")
    for foil in model["multilayer"]["stackup"]["copperLayers"]:
        patch = projected_aperture({"port": port, "zMin": foil["zMin"], "zMax": foil["zMax"], "corners": corners})
        if patch.is_empty:
            continue
        copper_shape = unary_union(list(copper[foil["name"]].values()))
        intersection = patch.intersection(copper_shape)
        if intersection.area > 1e-10 or (patch.geom_type == "LineString" and intersection.length > 1e-7):
            raise ValueError("Port aperture passes through intermediate copper; select closer explicit reference pins")
    for barrel in model["multilayer"]["barrels"]:
        patch = projected_aperture({"port": port, "zMin": barrel["zMin"], "zMax": barrel["zMax"], "corners": corners})
        if patch.is_empty:
            continue
        hole = Polygon(points(barrel["hole"]))
        annulus = hole.buffer(barrel["platingThickness"], join_style="mitre").difference(hole)
        intersection = patch.intersection(annulus)
        if intersection.area > 1e-10 or (patch.geom_type == "LineString" and intersection.length > 1e-7):
            raise ValueError("Port aperture passes through a plated barrel; select a clear terminal gap")


def stack_intervals(layered):
    """Z intervals between every foil, slab, barrel and drill boundary."""
    foils = layered["stackup"]["copperLayers"]
    z_min, z_max = foils[-1]["zMin"], foils[0]["zMax"]
    levels = []
    for z in sorted({z for item in [*foils, *layered["stackup"]["dielectrics"], *layered["barrels"], *layered["drills"]]
                     for z in (item["zMin"], item["zMax"])}):
        if z_min - 1e-9 <= z <= z_max + 1e-9 and (not levels or z - levels[-1] > 1e-9):
            levels.append(z)
    return list(zip(levels, levels[1:]))


# Parts of a piece thinner than 2 * SLIVER_MM move to their neighbour. The
# 0.5 um shift is far below the 3.3 um skin depth at 400 MHz and etch
# tolerance, while 1 nm necks left by unions and crops break surface meshing.
SLIVER_MM = 5e-4


def remove_slivers(entries):
    """Reassign sub-micron slivers inside one interval's planar partition.

    The partition stays complete and disjoint: each sliver leaves one piece
    and joins the neighbour sharing most of its boundary.
    """
    entries = [[material, shape] for material, shape in entries]
    for index in range(len(entries)):
        shape = entries[index][1]
        if shape.is_empty:
            continue
        kept = shape.buffer(-SLIVER_MM, join_style="mitre").buffer(SLIVER_MM, join_style="mitre").intersection(shape)
        for sliver in nonempty_polygons(clean(shape.difference(kept))):
            touching = [(sliver.boundary.intersection(other.buffer(1e-6)).length, other_index)
                        for other_index, (_, other) in enumerate(entries)
                        if other_index != index and not other.is_empty and other.distance(sliver) < 1e-6]
            if not touching:
                continue
            _, target = max(touching)
            entries[target][1] = clean(unary_union([entries[target][1], sliver]))
            entries[index][1] = clean(entries[index][1].difference(sliver))
    return entries


def partition_pieces(model, board, planar_copper, box):
    """Disjoint 2D material pieces for each z interval of the board stack.

    Material ownership matches the former overlapping-solid construction:
    copper wins, drilled holes and outer-foil gaps are air, inner-foil gaps
    belong to the slab above, and the air padding ring surrounds the board.
    """
    layered = model["multilayer"]
    foils = layered["stackup"]["copperLayers"]
    slabs = layered["stackup"]["dielectrics"]
    ring = clean(box.difference(board))
    pieces = []
    annuli = [(barrel, clean(Polygon(points(barrel["hole"])).buffer(barrel["platingThickness"], join_style="mitre")
                             .difference(Polygon(points(barrel["hole"]))).intersection(board)))
              for barrel in layered["barrels"]]
    for a, b in stack_intervals(layered):
        foil = next((f for f in foils if f["zMin"] - 1e-9 <= a and b <= f["zMax"] + 1e-9), None)
        drilled = clean(unary_union([Polygon(points(d["hole"])) for d in layered["drills"]
                                     if d["zMin"] <= a + 1e-9 and d["zMax"] >= b - 1e-9]))
        if foil:
            copper = planar_copper[foil["name"]]
            if foil is foils[0] or foil is foils[-1]:
                fill = ("air",)
            else:
                above = next((s for s in slabs if abs(s["zMin"] - foil["zMax"]) < 1e-8), None)
                if not above:
                    raise ValueError(f"No dielectric above inner foil {foil['name']}")
                fill = ("dielectric", above["attribute"])
        else:
            copper = {}
            for barrel, annulus in annuli:
                if barrel["zMin"] <= a + 1e-9 and barrel["zMax"] >= b - 1e-9:
                    copper[barrel["netId"]] = unary_union([copper.get(barrel["netId"], Polygon()), annulus])
            copper = {net: clean(shape) for net, shape in copper.items()}
            slab = next((s for s in slabs if s["zMin"] - 1e-9 <= a and b <= s["zMax"] + 1e-9), None)
            if not slab:
                raise ValueError(f"No stackup layer spans z={a}..{b}")
            fill = ("dielectric", slab["attribute"])
        metal = unary_union(list(copper.values()))
        holes = clean(drilled.difference(metal))
        rest = clean(board.difference(metal).difference(holes))
        entries = [(("copper", net_id), shape) for net_id, shape in copper.items()]
        if fill == ("air",):
            entries.append((("air",), clean(unary_union([ring, holes, rest]))))
        else:
            entries.extend([(("air",), clean(unary_union([ring, holes]))), (fill, rest)])
        for material, shape in remove_slivers(entries):
            if not shape.is_empty:
                pieces.append({"material": material, "shape": shape, "zMin": a, "zMax": b})
    return pieces


def node_key(x, y):
    """Planar vertex identity on the 1 nm geometry grid."""
    return (round(x * 1e6), round(y * 1e6))


def planar_cells(lines):
    """Polygonize the layers' combined linework after snap-rounding it.

    Snap-rounding to the sliver grid merges vertices and edges from different
    layers that nearly coincide, so no cell edge is shorter than SLIVER_MM.
    Sub-micron edges next to millimetre elements made 3D boundary recovery fail.
    A fixed-precision union is required: floating-point noding can leave a
    vertex lying on another edge unsplit, creating zero-width spikes in rings.
    """
    noded = union_all(lines, grid_size=SLIVER_MM)
    cells = list(polygonize(noded))
    # Grid-scale cells (a few snapped vertices) join the neighbour sharing most
    # of their boundary; dropping them would leave holes in the partition.
    tree = STRtree(cells)
    tiny = sorted((i for i, cell in enumerate(cells) if cell.area <= SLIVER_MM ** 2), key=lambda i: cells[i].area)
    merged = set()
    for index in tiny:
        shared = [(cells[index].boundary.intersection(cells[other].boundary).length, other)
                  for other in tree.query(cells[index], predicate="intersects")
                  if other != index and other not in merged]
        if not shared or max(shared)[0] <= 0:
            raise ValueError(f"Isolated grid-scale cell near {cells[index].representative_point().coords[0]}")
        target = max(shared)[1]
        cells[target] = union_all([cells[target], cells[index]], grid_size=SLIVER_MM)
        merged.add(index)
    cells = [cell for i, cell in enumerate(cells) if i not in merged]
    invalid = [cell for cell in cells if not cell.is_valid]
    if invalid:
        raise ValueError(f"Planar overlay produced an invalid cell near {invalid[0].representative_point().coords[0]}")
    return cells


def covering(tree, shapes, point, what):
    """Index of the shape covering point, allowing for snap-rounding drift."""
    hits = [i for i in tree.query(point, predicate="intersects") if shapes[i].covers(point)]
    if hits:
        return hits[0]
    # Snap-rounding can move a cell up to half a grid step off its piece.
    nearest = int(tree.query_nearest(point)[0])
    if shapes[nearest].distance(point) > SLIVER_MM:
        raise ValueError(f"{what} at {point.coords[0]} has no material")
    return nearest


def overlay_cells(pieces, box, cuts):
    """One planar arrangement shared by every interval.

    Each cell is labelled with its material in every interval. Cells thinner
    than 2 * SLIVER_MM adopt the neighbour sharing most of their boundary
    (edges on different layers that nearly coincide), then adjacent cells with
    identical labels dissolve so faces only remain where some material changes.
    Port cut lines are added last so their edges survive dissolving.
    """
    intervals = sorted({(p["zMin"], p["zMax"]) for p in pieces})
    lookup = []
    for interval in intervals:
        members = [p for p in pieces if (p["zMin"], p["zMax"]) == interval]
        shapes = [p["shape"] for p in members]
        lookup.append((STRtree(shapes), shapes, members))

    def label(cell):
        point = cell.representative_point()
        return tuple(members[covering(tree, shapes, point, "Planar cell")]["material"]
                     for tree, shapes, members in lookup)

    cells = planar_cells([box.boundary, *[p["shape"].boundary for p in pieces]])
    labels = [label(cell) for cell in cells]
    tree = STRtree(cells)
    for index, cell in enumerate(cells):
        if not cell.buffer(-SLIVER_MM, join_style="mitre").is_empty:
            continue
        shared = [(cell.boundary.intersection(cells[other].boundary).length, other)
                  for other in tree.query(cell, predicate="intersects") if other != index]
        if shared and max(shared)[0] > 0:
            labels[index] = labels[max(shared)[1]]
    groups = {}
    for cell, cell_label in zip(cells, labels):
        groups.setdefault(cell_label, []).append(cell)
    regions = [(cell_label, unary_union(members)) for cell_label, members in groups.items()]
    region_shapes = [region for _, region in regions]
    region_tree = STRtree(region_shapes)
    final, final_labels = [], []
    for cell in planar_cells([box.boundary, *[r.boundary for r in region_shapes], *cuts]):
        final.append(cell)
        final_labels.append(regions[covering(region_tree, region_shapes, cell.representative_point(), "Dissolved cell")][0])
    return intervals, final, final_labels


def build_layered_brep(cells, labels, levels, forced_lateral, forced_horizontal, protected, slanted):
    """Hand-built conforming B-rep from planar cells stacked over z levels.

    Step k spans levels[k]..levels[k+1]; labels[c][k] is cell c's material
    there. Faces exist only where materials differ (or where a port is forced),
    so no 3D Boolean is needed: shared curves are created once and reused.
    Returns volumes with materials, and faces with the material on each side.
    """
    g = gmsh.model.geo
    steps = len(levels) - 1

    xy, edges, rings = {}, {}, []
    for index, cell in enumerate(cells):
        cell_rings = []
        # Shells counter-clockwise and holes clockwise, so shared seams cancel.
        cell = orient(cell, sign=1.0)
        for ring in [cell.exterior, *cell.interiors]:
            ids = []
            for x, y in ring.coords[:-1]:
                k = node_key(x, y)
                xy.setdefault(k, (x, y))
                if not ids or ids[-1] != k:
                    ids.append(k)
            if len(ids) > 1 and ids[0] == ids[-1]:
                ids.pop()
            loop = []
            for a, b in zip(ids, ids[1:] + ids[:1]):
                edge = (a, b) if a < b else (b, a)
                edges.setdefault(edge, []).append(index)
                loop.append((edge, a < b))
            cell_rings.append(loop)
        rings.append(cell_rings)
    for edge, owners in edges.items():
        if len(owners) > 2:
            raise ValueError("Planar edge shared by more than two cells")
    if any(edge not in edges for edge, _ in forced_lateral):
        raise ValueError("Port segment is not a run of planar edges")

    parent = list(range(len(cells) * steps))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        parent[find(i)] = find(j)

    for owners in edges.values():
        if len(owners) == 2:
            for k in range(steps):
                if labels[owners[0]][k] == labels[owners[1]][k]:
                    union(owners[0] * steps + k, owners[1] * steps + k)
    for c in range(len(cells)):
        for k in range(steps - 1):
            if labels[c][k] == labels[c][k + 1]:
                union(c * steps + k, c * steps + k + 1)

    points, hlines, vlines = {}, {}, {}

    def point(node, level):
        if (node, level) not in points:
            points[(node, level)] = g.addPoint(*xy[node], levels[level])
        return points[(node, level)]

    def hline(edge, level):
        if (edge, level) not in hlines:
            hlines[(edge, level)] = g.addLine(point(edge[0], level), point(edge[1], level))
        return hlines[(edge, level)]

    def vline(node, step):
        if (node, step) not in vlines:
            vlines[(node, step)] = g.addLine(point(node, step), point(node, step + 1))
        return vlines[(node, step)]

    faces = []  # tag, comp on each side (None is outside), curve tags, bbox

    def side(c, k):
        return None if c is None or k < 0 or k >= steps else find(c * steps + k)

    def material(c, k):
        return None if c is None or k < 0 or k >= steps else labels[c][k]

    for edge, owners in edges.items():
        a, b = owners if len(owners) == 2 else (owners[0], None)
        k = 0
        while k < steps:
            forced = (edge, k) in forced_lateral
            if material(a, k) == material(b, k) and not forced:
                k += 1
                continue
            # Stack steps with the same materials on both sides into one face:
            # per-step strips as thin as a foil produced flat boundary tets.
            # Neither cell changes material at the levels in between, so no
            # horizontal face needs those level lines.
            end = k + 1
            while (not forced and end < steps and (edge, end) not in forced_lateral
                   and (material(a, end), material(b, end)) == (material(a, k), material(b, k))):
                end += 1
            curves = [hline(edge, k), *[vline(edge[1], j) for j in range(k, end)], -hline(edge, end),
                      *[-vline(edge[0], j) for j in reversed(range(k, end))]]
            tag = g.addPlaneSurface([g.addCurveLoop(curves)])
            (x0, y0), (x1, y1) = xy[edge[0]], xy[edge[1]]
            faces.append({"tag": tag, "sides": (side(a, k), side(b, k)), "materials": (material(a, k), material(b, k)),
                          "curves": [abs(c) for c in curves], "forced": forced, "kind": ("lateral", edge, k),
                          "bbox": (min(x0, x1), min(y0, y1), levels[k], max(x0, x1), max(y0, y1), levels[end])})
            k = end
    def signed_area(loop):
        coords = [xy[u] for u, _ in loop]
        return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(coords, coords[1:] + coords[:1])) / 2

    for level in range(steps + 1):
        # Adjacent cells with the same materials below and above share one
        # face: edges inside it would only constrain the mesh (flat boundary
        # tetrahedra formed on the outer box when it was tiled by every cell).
        members = [c for c in range(len(cells))
                   if material(c, level - 1) != material(c, level) or (c, level) in forced_horizontal]
        group = {c: c for c in members}

        def root(c):
            while group[c] != c:
                group[c] = group[group[c]]
                c = group[c]
            return c

        for edge, owners in edges.items():
            if len(owners) != 2 or not all(c in group for c in owners):
                continue
            if any((c, level) in forced_horizontal for c in owners):
                continue
            # Port cut lines stay in every surface: port faces end on them, and
            # merging around a port's ends would otherwise cancel its edges.
            if edge in protected:
                continue
            a, b = owners
            if (material(a, level - 1), material(a, level)) == (material(b, level - 1), material(b, level)):
                group[root(a)] = root(b)
        grouped = {}
        for c in members:
            grouped.setdefault(root(c), []).append(c)
        for group_cells in grouped.values():
            # Directed ring edges of interior seams cancel; the rest close into loops.
            directed = set()
            for c in group_cells:
                for loop in rings[c]:
                    for edge, forward in loop:
                        step = edge if forward else (edge[1], edge[0])
                        if (step[1], step[0]) in directed:
                            directed.remove((step[1], step[0]))
                        else:
                            directed.add(step)
            outgoing = {}
            for u, v in directed:
                outgoing.setdefault(u, []).append(v)
            loops = []
            while outgoing:
                start = next(iter(outgoing))
                loop, u = [], start
                while True:
                    v = outgoing[u].pop()
                    if not outgoing[u]:
                        del outgoing[u]
                    loop.append((u, v))
                    u = v
                    if u == start:
                        break
                loops.append(loop)
            shells = [loop for loop in loops if signed_area(loop) > 0]
            holes = [loop for loop in loops if signed_area(loop) < 0]
            shapes = [Polygon([xy[u] for u, _ in shell]) for shell in shells]
            assigned = {i: [] for i in range(len(shells))}
            for hole in holes:
                probe = Point(xy[hole[0][0]])
                inside = [i for i, shape in enumerate(shapes) if shape.buffer(1e-9).covers(probe)]
                assigned[min(inside, key=lambda i: shapes[i].area)].append(hole)
            first = group_cells[0]
            forced = (first, level) in forced_horizontal
            for index, shell in enumerate(shells):
                curves = [[hline((u, v) if u < v else (v, u), level) * (1 if u < v else -1) for u, v in loop]
                          for loop in [shell, *assigned[index]]]
                tag = g.addPlaneSurface([g.addCurveLoop(loop) for loop in curves])
                x0, y0, x1, y1 = shapes[index].bounds
                faces.append({"tag": tag, "sides": (side(first, level - 1), side(first, level)),
                              "materials": (material(first, level - 1), material(first, level)),
                              "curves": [abs(t) for loop in curves for t in loop], "forced": forced,
                              "kind": ("horizontal", first, level), "bbox": (x0, y0, levels[level], x1, y1, levels[level])})

    for spec in slanted:
        # A slanted lumped port inside one step: bottom and top run along port
        # cut edges at the step's levels, joined by two sloping side lines.
        k, bottom, top = spec["step"], spec["bottom"], spec["top"]
        for chain in (bottom, top):
            for a, b in zip(chain, chain[1:]):
                if ((a, b) if a < b else (b, a)) not in edges:
                    raise ValueError("Port segment is not a run of planar edges")
        curves = [hline((a, b) if a < b else (b, a), k) * (1 if a < b else -1) for a, b in zip(bottom, bottom[1:])]
        curves.append(g.addLine(point(bottom[-1], k), point(top[-1], k + 1)))
        curves.extend(hline((a, b) if a < b else (b, a), k + 1) * (1 if a < b else -1)
                      for a, b in zip(reversed(top), list(reversed(top))[1:]))
        curves.append(g.addLine(point(top[0], k + 1), point(bottom[0], k)))
        tag = g.addPlaneSurface([g.addCurveLoop(curves)])
        comp = side(spec["cell"], k)
        xs = [xy[n][0] for n in bottom + top]
        ys = [xy[n][1] for n in bottom + top]
        faces.append({"tag": tag, "sides": (comp, comp), "materials": (material(spec["cell"], k),) * 2,
                      "curves": [abs(c) for c in curves], "forced": True, "kind": spec["kind"],
                      "bbox": (min(xs), min(ys), levels[k], max(xs), max(ys), levels[k + 1])})

    comps = {}
    for face in faces:
        a, b = face["sides"]
        for comp in {a, b} - {None}:
            comps.setdefault(comp, {"material": None, "bounding": [], "embedded": []})
            (comps[comp]["embedded"] if a == b else comps[comp]["bounding"]).append(face)
    for c in range(len(cells)):
        for k in range(steps):
            comp = find(c * steps + k)
            if comp in comps:
                comps[comp]["material"] = labels[c][k]
    return faces, comps


def add_component_volume(comp):
    """Volume bounded by a component's faces, split into closed shells."""
    by_curve = {}
    for index, face in enumerate(comp["bounding"]):
        for curve in face["curves"]:
            by_curve.setdefault(curve, []).append(index)
    seen, shells = set(), []
    for start in range(len(comp["bounding"])):
        if start in seen:
            continue
        shell, pending = [], [start]
        seen.add(start)
        while pending:
            index = pending.pop()
            shell.append(index)
            for curve in comp["bounding"][index]["curves"]:
                for other in by_curve[curve]:
                    if other not in seen:
                        seen.add(other)
                        pending.append(other)
        shells.append(shell)

    def extent(shell):
        boxes = [comp["bounding"][i]["bbox"] for i in shell]
        lo = [min(b[j] for b in boxes) for j in range(3)]
        hi = [max(b[j + 3] for b in boxes) for j in range(3)]
        return (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])

    shells.sort(key=extent, reverse=True)
    loops = [gmsh.model.geo.addSurfaceLoop([comp["bounding"][i]["tag"] for i in shell]) for shell in shells]
    return gmsh.model.geo.addVolume(loops)


def stage(label, started):
    print(f"[{time.monotonic() - started:.1f}s] {label}", flush=True)


def generate_multilayer_mesh(model, destination):
    started = time.monotonic()
    layered = model["multilayer"]
    surface_impedance = model["copperModel"] == "surface_impedance_copper"
    board, planar_copper = layer_copper(model)
    stage("planar copper built", started)
    validate_reference_connectivity(model, planar_copper)
    stage("reference connectivity validated", started)
    gmsh.initialize()
    try:
        # Shared points and curves are deduplicated on the 1 nm grid by the
        # builder; Gmsh's own coherence pass would rescan every entity.
        gmsh.option.setNumber("Geometry.AutoCoherence", 0)
        gmsh.option.setNumber("Geometry.Tolerance", 1e-9)
        gmsh.model.add("multilayer-return-current")
        foil_layers = layered["stackup"]["copperLayers"]
        bottom, top = foil_layers[-1], foil_layers[0]
        for barrel in layered["barrels"]:
            hole = Polygon(points(barrel["hole"]))
            outer = hole.buffer(barrel["platingThickness"], join_style="mitre")
            pads = Polygon(points(barrel["pads"]))
            if not pads.buffer(2e-6).covers(outer) or (not layered.get("region") and not board.covers(pads)):
                raise ValueError("Plated barrel does not fit its pad/board")
        legacy = []
        for trace in model["geometry"]["signals"]:
            wires = [p for p in trace["route"] if p["route_type"] == "wire"]
            for endpoint, route in [(wires[0], wires[1:]), (wires[-1], list(reversed(wires[:-1])))]:
                neighbor = next((p for p in route if abs(p["x"] - endpoint["x"]) + abs(p["y"] - endpoint["y"]) > 1e-9), None)
                if not neighbor:
                    raise ValueError("Trace needs a nonzero segment for its terminal orientation")
                legacy.append(neighbor)
        apertures = []
        for index, port in enumerate(model["ports"]):
            # Find signal owner by the endpoint's copper. Named PCB pin ownership
            # was already validated by the TS model builder.
            endpoint = port["signal"]
            owners = [net for net, shape in planar_copper[port["signalLayer"]].items()
                      if shape.buffer(2e-6).covers(Point(endpoint["x"], endpoint["y"]))]
            if len(owners) != 1 or owners[0] == layered["referenceNetId"]:
                raise ValueError("Signal terminal must contact exactly one non-reference conductor")
            apertures.append(port_surface({"model": model, "port": port, "neighbor": legacy[index],
                                           "copper": planar_copper, "board": board, "signalNetId": owners[0]}))
        # Copper, dielectric and air are one planar arrangement stacked over z,
        # so the CAD model is assembled without any 3D Boolean. Overlapping
        # solids made the old global fragment exhaust memory on dense DDR crops.
        padding = model["airPadding"]
        min_x, min_y, max_x, max_y = board.bounds
        # The air box sits on the snap-rounding grid so its edges never move.
        lo_x, lo_y = [math.floor((v - padding) / SLIVER_MM) * SLIVER_MM for v in (min_x, min_y)]
        hi_x, hi_y = [math.ceil((v + padding) / SLIVER_MM) * SLIVER_MM for v in (max_x, max_y)]
        box = Polygon([(lo_x, lo_y), (hi_x, lo_y), (hi_x, hi_y), (lo_x, hi_y)])
        pieces = partition_pieces(model, board, planar_copper, box)
        stage(f"partitioned {len(pieces)} pieces", started)
        intervals = stack_intervals(layered)
        levels = [bottom["zMin"] - padding, *[a for a, _ in intervals], intervals[-1][1], top["zMax"] + padding]

        def level_index(z):
            matches = [i for i, level in enumerate(levels) if abs(level - z) < 1e-8]
            if len(matches) != 1:
                raise ValueError(f"Port height {z} is not a stack level")
            return matches[0]

        def snap(v):
            return round(v / SLIVER_MM) * SLIVER_MM

        cuts = []
        for aperture in apertures:
            # Apertures sit on the snap-rounding grid so their edges survive it.
            if aperture["kind"] == "coplanar":
                aperture["patch"] = set_precision(aperture["patch"], grid_size=SLIVER_MM)
                cuts.append(aperture["patch"].boundary)
                continue
            # The quad crosses each stack level in a segment. Every segment is
            # its snapped centre plus/minus one snapped half-width, so segments
            # stay exactly parallel and each per-step piece is exactly planar.
            (sx, sy), (rx, ry) = aperture["signal"], aperture["reference"]
            tx, ty = [snap(v) for v in aperture["halfWidth"]]
            signal_z, reference_z = aperture["signalZ"], aperture["referenceZ"]
            low, high = sorted([level_index(signal_z), level_index(reference_z)])
            aperture["segments"] = {}
            for level in range(low, high + 1):
                f = (levels[level] - signal_z) / (reference_z - signal_z)
                cx, cy = snap(sx + f * (rx - sx)), snap(sy + f * (ry - sy))
                aperture["segments"][level] = ((cx - tx, cy - ty), (cx + tx, cy + ty))
            reach = (max_x - min_x + max_y - min_y + 4 * padding) / (2 * (tx * tx + ty * ty) ** 0.5)
            for (x0, y0), (x1, y1) in set(aperture["segments"].values()):
                # Extend each footprint across the box so it splits cells cleanly.
                cuts.extend([LineString([(x0 - (x1 - x0) * reach, y0 - (y1 - y0) * reach), (x0, y0)]),
                             LineString([(x0, y0), (x1, y1)]),
                             LineString([(x1, y1), (x1 + (x1 - x0) * reach, y1 + (y1 - y0) * reach)])])
        cuts = [cut.intersection(box) for cut in cuts]
        overlay_intervals, cells, stack_labels = overlay_cells(pieces, box, cuts)
        if overlay_intervals != intervals:
            raise ValueError("Partition intervals differ from the stack intervals")
        labels = [(("air",), *label, ("air",)) for label in stack_labels]
        stage(f"overlaid {len(cells)} planar cells over {len(levels) - 1} z steps", started)

        def on_segment(px, py, segment):
            # Snap-rounded crossings sit up to half a grid diagonal off the line.
            return LineString(segment).distance(Point(px, py)) < SLIVER_MM

        cell_tree = STRtree(cells)

        def segment_nodes(segment):
            """Overlay vertices on a port segment, ordered from its start."""
            (x0, y0), (x1, y1) = segment
            found = {}
            for index in cell_tree.query(LineString(segment).buffer(SLIVER_MM)):
                cell = cells[index]
                for ring in [cell.exterior, *cell.interiors]:
                    for x, y in ring.coords:
                        if on_segment(x, y, segment):
                            found[node_key(x, y)] = (x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)
            return sorted(found, key=found.get)

        def segment_edges(segment):
            nodes = segment_nodes(segment)
            return [(a, b) if a < b else (b, a) for a, b in zip(nodes, nodes[1:])]

        forced_lateral, forced_horizontal, port_kinds, slanted = set(), set(), [], []
        for aperture in apertures:
            kinds = set()
            if aperture["kind"] == "coplanar":
                level = level_index(aperture["z"])
                for index, cell in enumerate(cells):
                    # The aperture is the clear gap: grid-scale copper cells left
                    # where the snapped patch meets rounded trace ends are excluded.
                    touching = [labels[index][k] for k in (level - 1, level) if 0 <= k < len(labels[index])]
                    if any(material[0] == "copper" for material in touching):
                        continue
                    if aperture["patch"].buffer(SLIVER_MM).covers(cell):
                        kinds.add(("horizontal", index, level))
            else:
                segments = aperture["segments"]
                ordered = sorted(segments)
                for k, k_next in zip(ordered, ordered[1:]):
                    if segments[k] == segments[k_next]:
                        # Vertical in this step: the port is a run of side faces.
                        for edge in segment_edges(segments[k]):
                            kinds.add(("lateral", edge, k))
                    else:
                        (x0, y0), (x1, y1) = segments[k]
                        (x2, y2), (x3, y3) = segments[k_next]
                        center = Point((x0 + x1 + x2 + x3) / 4, (y0 + y1 + y2 + y3) / 4)
                        slanted.append({"kind": ("slanted", len(port_kinds), k), "step": k,
                                        "bottom": segment_nodes(segments[k]), "top": segment_nodes(segments[k_next]),
                                        "cell": covering(cell_tree, cells, center, "Port aperture")})
                        kinds.add(("slanted", len(port_kinds), k))
            if not kinds:
                raise ValueError("Lumped port aperture produced no surface")
            forced_lateral.update((kind[1], kind[2]) for kind in kinds if kind[0] == "lateral")
            forced_horizontal.update((kind[1], kind[2]) for kind in kinds if kind[0] == "horizontal")
            port_kinds.append(kinds)
        protected = set()
        for cell in cells:
            for ring in [cell.exterior, *cell.interiors]:
                coords = list(ring.coords)
                for (ax, ay), (bx, by) in zip(coords, coords[1:]):
                    if any(cut.distance(Point(ax, ay)) < SLIVER_MM and cut.distance(Point(bx, by)) < SLIVER_MM
                           for cut in cuts):
                        a, b = node_key(ax, ay), node_key(bx, by)
                        protected.add((a, b) if a < b else (b, a))
        faces, comps = build_layered_brep(cells, labels, levels, forced_lateral, forced_horizontal, protected, slanted)
        stage(f"built {len(faces)} faces and {len(comps)} material regions", started)
        for face in faces:
            if None in face["sides"] and face["kind"][0] == "lateral":
                x0, y0, _, x1, y1, _ = face["bbox"]
                bx0, by0, bx1, by1 = box.bounds
                if not (max(abs(x0 - bx0), abs(x1 - bx0)) < 1e-6 or max(abs(x0 - bx1), abs(x1 - bx1)) < 1e-6
                        or max(abs(y0 - by0), abs(y1 - by0)) < 1e-6 or max(abs(y0 - by1), abs(y1 - by1)) < 1e-6):
                    raise ValueError(f"Non-conforming planar edge inside the model near {face['bbox'][:2]}")
        volume_material = {}
        for comp in comps.values():
            if surface_impedance and comp["material"][0] == "copper":
                continue
            volume_material[add_component_volume(comp)] = comp
        gmsh.model.geo.synchronize()
        for tag, comp in volume_material.items():
            if comp["embedded"]:
                gmsh.model.mesh.embed(2, [face["tag"] for face in comp["embedded"]], 3, tag)
        stage(f"synchronized {len(volume_material)} volumes", started)
        copper_tags = {tag for tag, comp in volume_material.items() if comp["material"][0] == "copper"}
        if not any(comp["material"][0] == "copper" for comp in comps.values()):
            raise ValueError("Empty copper model")
        if not surface_impedance:
            gmsh.model.addPhysicalGroup(3, sorted(copper_tags), 3, "copper")
        dielectric_tags = set()
        for slab in layered["stackup"]["dielectrics"]:
            attribute = slab["attribute"]
            tags = {tag for tag, comp in volume_material.items() if comp["material"] == ("dielectric", attribute)}
            if not tags:
                raise ValueError("Empty dielectric slab")
            gmsh.model.addPhysicalGroup(3, sorted(tags), attribute, f"dielectric-{attribute}")
            dielectric_tags.update(tags)
        air_tags = {tag for tag, comp in volume_material.items() if comp["material"] == ("air",)}
        gmsh.model.addPhysicalGroup(3, sorted(air_tags), 1, "air")
        by_kind = {face["kind"]: face for face in faces}
        port_tags = []
        for index, kinds in enumerate(port_kinds):
            tags = [by_kind[kind]["tag"] for kind in kinds]
            if set(tags).intersection(port_tags):
                raise ValueError("Lumped ports overlap or have no surface")
            gmsh.model.addPhysicalGroup(2, tags, 21 + index, f"port-{index + 1}")
            port_tags.extend(tags)
        outer = [face["tag"] for face in faces if None in face["sides"]]
        gmsh.model.addPhysicalGroup(2, outer, 13, "outer-air")

        def is_copper(material):
            return material is not None and material[0] == "copper"

        copper_faces = [face for face in faces if any(is_copper(m) for m in face["materials"])]
        copper_surfaces = [face["tag"] for face in copper_faces]
        copper_volume = sum(cells[c].area * (levels[k + 1] - levels[k])
                            for c in range(len(cells)) for k in range(len(levels) - 1) if is_copper(labels[c][k]))
        if surface_impedance:
            # Conductor interfaces face air or dielectric; copper interiors are not solved.
            exposed = [face for face in copper_faces if sum(is_copper(m) for m in face["materials"]) == 1]
            reference = ("copper", layered["referenceNetId"])
            ground_faces = {face["tag"] for face in exposed if reference in face["materials"]}
            signal_faces = {face["tag"] for face in exposed} - ground_faces
            if not ground_faces or not signal_faces:
                raise ValueError("Surface impedance requires exposed reference and signal conductor interfaces")
            if (ground_faces | signal_faces).intersection(port_tags):
                raise ValueError("Lumped port aperture overlaps a conductor impedance face")
            gmsh.model.addPhysicalGroup(2, sorted(ground_faces), 11, "reference-copper")
            gmsh.model.addPhysicalGroup(2, sorted(signal_faces), 12, "other-copper")
            copper_surfaces = sorted(ground_faces | signal_faces)
        edges = sorted({tag for dim, tag in gmsh.model.getBoundary([(2, tag) for tag in [*copper_surfaces, *port_tags]], combined=False, oriented=False) if dim == 1})
        distance = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(distance, "CurvesList", edges)
        gmsh.model.mesh.field.setNumber(distance, "Sampling", 50)
        threshold = gmsh.model.mesh.field.add("Threshold")
        for key, number in {"InField": distance, "SizeMin": min(model["meshSize"] / 3, model["portWidth"] / 2), "SizeMax": model["meshSize"], "DistMin": 0.05, "DistMax": 0.8}.items():
            gmsh.model.mesh.field.setNumber(threshold, key, number)
        gmsh.model.mesh.field.setAsBackgroundMesh(threshold)
        # One thread: parallel surface meshing made the mesh differ run to run, and
        # some draws left near-zero-volume tets (min SICN 1.6e-12 on DDR_CSn0).
        for key, number in {"Mesh.MeshSizeExtendFromBoundary": 0, "Mesh.MeshSizeFromPoints": 0,
                            "Mesh.MeshSizeFromCurvature": 0, "Mesh.Algorithm3D": 1,
                            "General.NumThreads": 1, "Mesh.MshFileVersion": 2.2}.items():
            gmsh.option.setNumber(key, number)
        stage("physical groups assigned", started)
        gmsh.model.mesh.generate(3)
        # The default optimizer leaves some ill-shaped tets; relocating vertices
        # keeps the element set and lifts the worst quality.
        gmsh.model.mesh.optimize("Relocate3D")
        stage("mesh generated", started)
        gmsh.write(str(destination / "mesh.msh"))
        tetrahedra = [int(tag) for tags in gmsh.model.mesh.getElements(3)[1] for tag in tags]
        qualities = gmsh.model.mesh.getElementQualities(tetrahedra, "minSICN")
        minimum_quality = float(min(qualities))
        if not minimum_quality > 1e-8:
            raise ValueError(f"Degenerate/inverted tetrahedra: min SICN={minimum_quality}")
        summary = {"minimumSicn": minimum_quality, "geometryPrecisionMm": SLIVER_MM, "nodes": len(gmsh.model.mesh.getNodes()[0]),
                   "tetrahedra": sum(len(tags) for tags in gmsh.model.mesh.getElements(3)[1]),
                   "copperVolumeMm3": copper_volume,
                   "dielectricAttributes": [slab["attribute"] for slab in layered["stackup"]["dielectrics"]],
                   "portAttributes": list(range(21, 21 + len(apertures))),
                   "sampleLayer": layered["sampleLayer"]}
        if surface_impedance:
            summary.update({"copperModel": model["copperModel"], "conductivityBoundaryAttributes": [11, 12],
                            "surfaceImpedance": model["surfaceImpedance"]})
        (destination / "mesh-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    finally:
        gmsh.finalize()
    return len(model["ports"])

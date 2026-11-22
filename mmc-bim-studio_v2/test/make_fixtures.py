"""Minimal ASCII DXF writer used to build realistic test drawings for MMC BIM Studio.

Only emits what the studio's reader supports: LINE / LWPOLYLINE / CIRCLE / ARC / TEXT,
a $INSUNITS header, and named layers.
"""
import math


class Dxf:
    def __init__(self, insunits=6):  # 6 = metres
        self.insunits = insunits
        self.entities = []      # list of (layer, type, payload)
        self.layers = set()

    # ── primitives ────────────────────────────────────────────────────────────
    def line(self, layer, x1, y1, x2, y2):
        self.layers.add(layer)
        self.entities.append((layer, "LINE", (x1, y1, x2, y2)))

    def rect(self, layer, x, y, w, h):
        self.poly(layer, [(x, y), (x + w, y), (x + w, y + h), (x, y + h)], closed=True)

    def poly(self, layer, pts, closed=True):
        self.layers.add(layer)
        self.entities.append((layer, "LWPOLYLINE", (pts, closed)))

    def circle(self, layer, x, y, r):
        self.layers.add(layer)
        self.entities.append((layer, "CIRCLE", (x, y, r)))

    def arc(self, layer, x, y, r, a0, a1):
        self.layers.add(layer)
        self.entities.append((layer, "ARC", (x, y, r, a0, a1)))

    def text(self, layer, x, y, h, value):
        self.layers.add(layer)
        self.entities.append((layer, "TEXT", (x, y, h, value)))

    # ── output ────────────────────────────────────────────────────────────────
    def _g(self, out, code, value):
        out.append(str(code))
        out.append(str(value))

    def dumps(self):
        out = []
        self._g(out, 0, "SECTION"); self._g(out, 2, "HEADER")
        self._g(out, 9, "$INSUNITS"); self._g(out, 70, self.insunits)
        self._g(out, 9, "$ACADVER"); self._g(out, 1, "AC1015")
        self._g(out, 0, "ENDSEC")

        self._g(out, 0, "SECTION"); self._g(out, 2, "TABLES")
        self._g(out, 0, "TABLE"); self._g(out, 2, "LAYER"); self._g(out, 70, len(self.layers))
        for name in sorted(self.layers):
            self._g(out, 0, "LAYER")
            self._g(out, 2, name)
            self._g(out, 70, 0)
            self._g(out, 62, 7)
            self._g(out, 6, "CONTINUOUS")
        self._g(out, 0, "ENDTAB")
        self._g(out, 0, "ENDSEC")

        self._g(out, 0, "SECTION"); self._g(out, 2, "ENTITIES")
        for layer, kind, pl in self.entities:
            self._g(out, 0, kind)
            self._g(out, 8, layer)
            if kind == "LINE":
                x1, y1, x2, y2 = pl
                self._g(out, 10, x1); self._g(out, 20, y1); self._g(out, 30, 0)
                self._g(out, 11, x2); self._g(out, 21, y2); self._g(out, 31, 0)
            elif kind == "LWPOLYLINE":
                pts, closed = pl
                self._g(out, 90, len(pts)); self._g(out, 70, 1 if closed else 0)
                for (x, y) in pts:
                    self._g(out, 10, x); self._g(out, 20, y)
            elif kind == "CIRCLE":
                x, y, r = pl
                self._g(out, 10, x); self._g(out, 20, y); self._g(out, 30, 0); self._g(out, 40, r)
            elif kind == "ARC":
                x, y, r, a0, a1 = pl
                self._g(out, 10, x); self._g(out, 20, y); self._g(out, 30, 0)
                self._g(out, 40, r); self._g(out, 50, a0); self._g(out, 51, a1)
            elif kind == "TEXT":
                x, y, h, value = pl
                self._g(out, 10, x); self._g(out, 20, y); self._g(out, 30, 0)
                self._g(out, 40, h); self._g(out, 1, value)
        self._g(out, 0, "ENDSEC")
        self._g(out, 0, "EOF")
        return "\r\n".join(out) + "\r\n"

    def save(self, path):
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(self.dumps())
        return path


# ══════════════════════════════════════════════════════════════════════════════
def building_plan(stories=2, bays_x=4, bays_y=3, bay_x=5.0, bay_y=4.0,
                  col=0.40, beam_w=0.30, footing=2.00, wall_t=0.20,
                  door=1.00, window_w=1.60, add_services=True):
    """A rectangular frame building with foundations, columns, beams, slab,
    walls, doors, windows, and (optionally) MEP linework laid over the plan.

    Every number below is a *stated design value*, never an inference:
    bay spacing, member sections and opening sizes are design decisions.
    """
    d = Dxf(6)
    W, H = bays_x * bay_x, bays_y * bay_y          # 20.0 x 12.0 m

    # ── site / grid ───────────────────────────────────────────────────────────
    for i in range(bays_x + 1):
        x = i * bay_x
        d.line("A-GRID", x, -1.0, x, H + 1.0)
    for j in range(bays_y + 1):
        y = j * bay_y
        d.line("A-GRID", -1.0, y, W + 1.0, y)
    d.text("A-TEXT", 0.0, H + 1.6, 0.35, "GROUND FLOOR PLAN  1:100")

    # ── structural: slab outline + interior slab edges ────────────────────────
    d.rect("S-SLAB", 0, 0, W, H)
    for i in range(1, bays_x):
        d.line("S-SLAB", i * bay_x, 0, i * bay_x, H)
    for j in range(1, bays_y):
        d.line("S-SLAB", 0, j * bay_y, W, j * bay_y)

    # ── structural: columns (0.40 x 0.40 at every grid intersection) ──────────
    for i in range(bays_x + 1):
        for j in range(bays_y + 1):
            x, y = i * bay_x, j * bay_y
            d.rect("S-COLS", x - col / 2, y - col / 2, col, col)

    # ── structural: beams (centre lines along each grid line) ─────────────────
    for j in range(bays_y + 1):
        d.line("S-BEAMS", 0, j * bay_y, W, j * bay_y)
    for i in range(bays_x + 1):
        d.line("S-BEAMS", i * bay_x, 0, i * bay_x, H)

    # ── structural: isolated footings under each column ───────────────────────
    for i in range(bays_x + 1):
        for j in range(bays_y + 1):
            x, y = i * bay_x, j * bay_y
            d.rect("S-FNDN", x - footing / 2, y - footing / 2, footing, footing)

    # ── architectural: external walls on the perimeter ────────────────────────
    d.poly("A-WALL", [(0, 0), (W, 0), (W, H), (0, H)], closed=True)
    # two interior partitions
    d.line("A-WALL", bay_x * 2, 0, bay_x * 2, H)
    d.line("A-WALL", 0, bay_y * 2, W, bay_y * 2)

    # ── architectural: floor finish ───────────────────────────────────────────
    d.rect("A-FLOR", 0.10, 0.10, W - 0.20, H - 0.20)

    # ── architectural: doors (leaf + swing arc) ───────────────────────────────
    doors = [
        (3.0, 0.0, 0.0), (9.0, 0.0, 0.0), (15.0, 0.0, 0.0),
        (bay_x * 2, 6.0, 90.0), (bay_x * 2, 9.5, 90.0),
        (6.0, H, 180.0), (13.0, H, 180.0), (18.0, H, 180.0),
    ]
    for (x, y, rot) in doors:
        a = math.radians(rot)
        d.line("A-DOOR", x, y, x + door * math.cos(a), y + door * math.sin(a))
        d.arc("A-DOOR", x, y, door, rot, rot + 90)

    # ── architectural: windows on the two long facades ────────────────────────
    for x0 in (1.2, 6.2, 11.2, 16.2):
        d.rect("A-GLAZ", x0, -wall_t / 2, window_w, wall_t)
        d.rect("A-GLAZ", x0, H - wall_t / 2, window_w, wall_t)
    for y0 in (1.0, 6.0):
        d.rect("A-GLAZ", -wall_t / 2, y0, wall_t, window_w)
        d.rect("A-GLAZ", W - wall_t / 2, y0, wall_t, window_w)

    # ── electrical: luminaires, sockets, panel, cabling ───────────────────────
    lum = 0
    for i in range(bays_x):
        for j in range(bays_y):
            d.circle("E-LITE", i * bay_x + bay_x / 2, j * bay_y + bay_y / 2, 0.30)
            lum += 1
    sockets = [(1.0, 0.4), (1.0, 4.6), (1.0, 8.2), (6.0, 0.4), (11.0, 0.4),
               (16.0, 0.4), (6.0, 11.6), (11.0, 11.6), (16.0, 11.6), (19.0, 4.6)]
    for (x, y) in sockets:
        d.rect("E-POWR", x, y, 0.25, 0.25)
    d.rect("E-PANL", 0.6, 11.0, 0.80, 0.30)
    d.rect("E-PANL", 19.0, 0.6, 0.80, 0.30)
    # conduit runs from each panel to its zone
    for (x1, y1, x2, y2) in [(1.2, 11.15, 9.0, 11.15), (1.2, 11.15, 1.2, 2.0),
                             (19.2, 0.75, 12.0, 0.75)]:
        d.line("E-CABL", x1, y1, x2, y2)

    if add_services:
        # ── mechanical: supply duct main + branches, diffusers ────────────────
        d.line("M-DUCT", 1.0, 10.5, 19.0, 10.5)                 # main run
        for i in range(1, bays_x):
            d.line("M-DUCT", i * bay_x, 10.5, i * bay_x, 6.5)   # branches
        for i in range(bays_x):
            d.rect("M-DIFF", i * bay_x + bay_x / 2 - 0.25, 6.25, 0.50, 0.50)
        d.rect("M-EQPM", 8.0, 10.0, 1.20, 1.00)                 # AHU
        # ── plumbing: water supply + drainage ─────────────────────────────────
        d.line("P-DOMW", 0.5, 9.5, 9.5, 9.5)
        d.line("P-SANR", 9.5, 9.5, 9.5, 2.0)
        d.line("P-SANR", 9.5, 2.0, 18.5, 2.0)
        d.circle("P-FIXT", 9.5, 8.0, 0.20)
        d.circle("P-FIXT", 9.5, 4.0, 0.20)

    return d


if __name__ == "__main__":
    import os
    os.makedirs("test/fixtures", exist_ok=True)
    p1 = building_plan().save("test/fixtures/building-rev-a.dxf")
    p2 = building_plan(bays_x=5, door=1.10, window_w=1.80,
                       add_services=True).save("test/fixtures/building-rev-b.dxf")
    for p in (p1, p2):
        print(p, os.path.getsize(p), "bytes")

#!/usr/bin/env python3
"""
Erzeugt Referenzdaten (golden files) mit dem ORIGINAL-Code von K40 Whisperer (egv.py,
LaserSpeed.py aus dem übergeordneten Ordner). Die TypeScript-Tests vergleichen ihre
Ausgabe Byte für Byte mit diesen Daten.
"""
import json
import os
import random
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ORIG = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(HERE, '..', 'test', 'golden')

# interpolate.py im Original ist leer -> Stub, damit egv.py importiert werden kann
stub = types.ModuleType('interpolate')
stub.interpolate = None
sys.modules['interpolate'] = stub
sys.path.insert(0, ORIG)

from egv import egv  # noqa: E402
from LaserSpeed import LaserSpeed  # noqa: E402

rnd = random.Random(4040)
BOARDS = ['M2', 'M1', 'M', 'B2', 'B1', 'B', 'A']


def speed_cases():
    cases = []
    speeds = [0.1, 0.5, 1, 2, 3, 5, 6, 6.5, 7, 7.5, 10, 12.7, 15, 19.05, 20, 25, 25.4, 26, 30, 40, 50,
              59.9, 60, 61, 80, 100, 126.9, 127, 150, 200, 240, 250, 300, 320, 400, 500]
    for board in BOARDS:
        for s in speeds:
            for step in [0, 1, 2, 3, 5]:
                if step == 0 and s > 240:
                    continue
                code = LaserSpeed.get_code_from_speed(s, step, board=board)
                cases.append({'board': board, 'speed': s, 'step': step, 'code': code})
    return cases


def run_egv(ecoords, **kw):
    data = []
    e = egv(target=lambda s: data.append(s))
    e.make_egv_data(ecoords, **kw)
    return data


def random_polyline_loops(n_loops, extent):
    ecoords = []
    loop = 0
    for _ in range(n_loops):
        loop += 1
        n = rnd.randint(2, 12)
        x0 = rnd.uniform(0, extent)
        y0 = -rnd.uniform(0, extent)
        pts = [(x0, y0)]
        for _ in range(n - 1):
            kind = rnd.random()
            if kind < 0.2:   # horizontal
                pts.append((rnd.uniform(0, extent), pts[-1][1]))
            elif kind < 0.4:  # vertical
                pts.append((pts[-1][0], -rnd.uniform(0, extent)))
            elif kind < 0.5:  # 45 Grad
                d = rnd.uniform(-1, 1)
                pts.append((pts[-1][0] + d, pts[-1][1] + d))
            elif kind < 0.6:  # winzig
                pts.append((pts[-1][0] + rnd.uniform(-0.004, 0.004), pts[-1][1] + rnd.uniform(-0.004, 0.004)))
            else:
                pts.append((rnd.uniform(0, extent), -rnd.uniform(0, extent)))
        if rnd.random() < 0.5:
            pts.append(pts[0])  # geschlossen
        for p in pts:
            ecoords.append([p[0], p[1], loop])
    return ecoords


def vector_cases():
    cases = []
    for i in range(60):
        ec = random_polyline_loops(rnd.randint(1, 8), rnd.choice([0.05, 0.5, 3, 8]))
        board = rnd.choice(BOARDS)
        feed = rnd.choice([1, 5, 6.9, 10, 15, 20, 30, 50, 100, 150])
        rapid = rnd.choice([0, 0, 0, 10])
        startX = rnd.choice([0, 0.25])
        startY = rnd.choice([0, -0.1])
        data = run_egv(ec, startX=startX, startY=startY, Feed=feed, board_name='LASER-' + board,
                       Raster_step=0, Rapid_Feed_Rate=rapid)
        cases.append({'ecoords': ec, 'startX': startX, 'startY': startY, 'feed': feed, 'board': board,
                      'rapid': rapid, 'data': data})
    return cases


def random_raster_ecoords(rows, width_px, step_mils, density):
    """Wie make_raster_coords im Original: Zeilen von oben nach unten, y fallend."""
    ecoords = []
    loop = 0
    for r in range(rows):
        y = -(r * step_mils) / 1000.0
        if rnd.random() < 0.15:
            continue  # leere Zeile
        x = 0
        on = rnd.random() < 0.5
        while x < width_px:
            run = rnd.randint(1, max(1, width_px // 6))
            run = min(run, width_px - x)
            if on and rnd.random() < density:
                loop += 1
                ecoords.append([x / 1000.0, y, loop])
                ecoords.append([(x + run) / 1000.0, y, loop])
            x += run
            on = not on
    return ecoords


def raster_cases():
    cases = []
    for i in range(30):
        step = rnd.choice([1, 2, 3, 4])
        ec = random_raster_ecoords(rnd.randint(3, 40), rnd.randint(20, 900), step, rnd.choice([0.3, 0.9]))
        if not ec:
            continue
        board = rnd.choice(BOARDS)
        feed = rnd.choice([20, 50, 100, 200, 350])
        up = rnd.random() < 0.3
        raster_step = step if up else -step
        rapid = rnd.choice([0, 0, 0, 10])
        startY = 0.0
        data = run_egv(ec, startX=0, startY=startY, Feed=feed, board_name='LASER-' + board,
                       Raster_step=raster_step, Rapid_Feed_Rate=rapid)
        stripped = egv().strip_redundant_codes(data)
        cases.append({'ecoords': ec, 'startX': 0, 'startY': startY, 'feed': feed, 'board': board,
                      'rasterStep': raster_step, 'rapid': rapid, 'data': data, 'stripped': stripped})
    return cases


def move_cases():
    cases = []
    for _ in range(40):
        dx = rnd.randint(-9000, 9000)
        dy = rnd.randint(-9000, 9000)
        if rnd.random() < 0.2:
            dx = 0
        data = []
        egv(target=lambda s: data.append(s)).make_move_data(dx, dy)
        cases.append({'dx': dx, 'dy': dy, 'data': data})
    return cases


def rapid_cases():
    cases = []
    for _ in range(20):
        dx = rnd.randint(-3000, 3000)
        dy = rnd.randint(-3000, 3000)
        feed = rnd.choice([5, 10, 20])
        board = rnd.choice(BOARDS)
        data = []
        egv(target=lambda s: data.append(s)).make_egv_rapid(dx, dy, Feed=feed, board_name='LASER-' + board)
        cases.append({'dx': dx, 'dy': dy, 'feed': feed, 'board': board, 'data': data})
    return cases


def packet_cases():
    from nano_library import K40_CLASS
    cases = []
    for n in [1, 2, 29, 30, 31, 59, 60, 61, 95, 300]:
        data = [rnd.randint(0, 255) for _ in range(n)]
        k = K40_CLASS()
        packets = []
        k.send_packet_w_error_checking = lambda line, update_gui=None, stop_calc=None: packets.append(list(line))
        k.send_data(list(data), preprocess_crc=True, wait_for_laser=False)
        cases.append({'data': data, 'packets': packets})
    return cases


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, fn in [('speed', speed_cases), ('vector', vector_cases), ('raster', raster_cases),
                     ('move', move_cases), ('rapid', rapid_cases), ('packets', packet_cases)]:
        cases = fn()
        with open(os.path.join(OUT, name + '.json'), 'w') as f:
            json.dump(cases, f)
        print(name, len(cases))

"""Генерация build/icon.ico без сторонних зависимостей.

Мотив — три столбика из ThreadBars, монохром на тёмной плашке с тонкой
светлой рамкой: силуэт читается и на тёмной, и на светлой панели задач.
"""
import math, struct, zlib

TILE   = (0x15, 0x17, 0x1a)
BORDER = (0x84, 0x8a, 0x8e)
BAR    = (0xe2, 0xe4, 0xe6)

MARGIN, RADIUS, STROKE = 0.02, 0.21, 0.042
BASE, BAR_W, GAP = 0.765, 0.155, 0.065
HEIGHTS = (0.30, 0.48, 0.38)
X0 = (1 - (3 * BAR_W + 2 * GAP)) / 2


def rounded_rect_sdf(x, y):
    """Расстояние до скруглённого квадрата: < 0 внутри."""
    hx = hy = 0.5 - MARGIN
    dx = abs(x - 0.5) - (hx - RADIUS)
    dy = abs(y - 0.5) - (hy - RADIUS)
    ox, oy = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - RADIUS


def bars():
    for i, h in enumerate(HEIGHTS):
        x = X0 + i * (BAR_W + GAP)
        yield x, x + BAR_W, BASE - h, BASE


BAR_RECTS = tuple(bars())


def sample(x, y):
    """Цвет точки или None, если она вне плашки."""
    d = rounded_rect_sdf(x, y)
    if d >= 0:
        return None
    if d > -STROKE:
        return BORDER
    for x0, x1, y0, y1 in BAR_RECTS:
        if x0 <= x <= x1 and y0 <= y <= y1:
            return BAR
    return TILE


def render(size, ss=4):
    out = bytearray(size * size * 4)
    step, total = 1.0 / (size * ss), float(ss * ss)
    for py in range(size):
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                y = (py * ss + sy + 0.5) * step
                for sx in range(ss):
                    c = sample((px * ss + sx + 0.5) * step, y)
                    if c is not None:
                        r += c[0]; g += c[1]; b += c[2]; a += 255
            i = (py * size + px) * 4
            if a:
                # цвет усредняем только по покрытым подпикселям, иначе края темнеют
                n = a / 255
                out[i:i + 4] = bytes((round(r / n), round(g / n), round(b / n), round(a / total)))
    return bytes(out)


def png(size, rgba):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    raw = b''.join(b'\x00' + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def ico(images):
    """images: [(size, png_bytes)] — Windows понимает PNG внутри ICO с Vista."""
    head = struct.pack('<HHH', 0, 1, len(images))
    offset = len(head) + 16 * len(images)
    entries, blobs = b'', b''
    for size, blob in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        blobs += blob
    return head + entries + blobs


if __name__ == '__main__':
    import os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    images = [(size, png(size, render(size))) for size in (16, 24, 32, 48, 64, 128, 256)]
    blob = ico(images)

    # build/icon.ico — для electron-builder (exe и установщик),
    # public/icon.ico — для окна и трея: Vite копирует public/ в dist/.
    for target in (os.path.join(root, 'build', 'icon.ico'),
                   os.path.join(root, 'public', 'icon.ico')):
        with open(target, 'wb') as f:
            f.write(blob)
        print('written', os.path.relpath(target, root))

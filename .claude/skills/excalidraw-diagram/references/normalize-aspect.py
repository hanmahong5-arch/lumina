#!/usr/bin/env uv run
"""Normalize excalidraw element layout to fit 16:9 aspect ratio (1.4-2.0)."""
import json, sys, os, math

def get_bounds(elements, skip_deleted=True):
    xmin = ymin = float('inf')
    xmax = ymax = float('-inf')
    for e in elements:
        if skip_deleted and e.get('isDeleted', False):
            continue
        if e['type'] in ('text', 'rectangle', 'diamond', 'ellipse'):
            xmin = min(xmin, e['x']); ymin = min(ymin, e['y'])
            xmax = max(xmax, e['x'] + e.get('width', 0))
            ymax = max(ymax, e['y'] + e.get('height', 0))
        elif e['type'] in ('line', 'arrow'):
            for dx, dy in e.get('points', [[0,0]]):
                xmin = min(xmin, e['x'] + dx); ymin = min(ymin, e['y'] + dy)
                xmax = max(xmax, e['x'] + dx); ymax = max(ymax, e['y'] + dy)
    return xmin, ymin, xmax, ymax

def normalize(data, target_ar=1.78, tol=0.05):
    elements = [e for e in data['elements'] if not e.get('isDeleted', False)]
    if not elements:
        return False
    xmin, ymin, xmax, ymax = get_bounds(elements)
    cw, ch = xmax - xmin, ymax - ymin
    if ch <= 0 or cw <= 0:
        return False
    current_ar = cw / ch
    if 1.4 <= current_ar <= 2.0:
        return False  # already OK

    # Determine target canvas and shift
    if current_ar > 2.0:
        tw, th = cw, cw / target_ar
        dy = (th - ch) / 2.0
        dx = 0
    else:
        tw, th = ch * target_ar, ch
        dx = (tw - cw) / 2.0
        dy = 0

    # Scale factor (>=1.0 so we never shrink content)
    sf = max(tw / cw, th / ch)
    sw, sh = cw * sf, ch * sf
    sx_off = xmin + cw / 2 - sw / 2
    sy_off = ymin + ch / 2 - sh / 2

    for e in elements:
        e['x'] = (e['x'] - sx_off) * sf + dx - xmin * sf
        e['y'] = (e['y'] - sy_off) * sf + dy - ymin * sf
        for k in ('width', 'height'):
            if k in e:
                e[k] = round(e[k] * sf)
        # Handle line/arrow points
        if e['type'] in ('line', 'arrow'):
            pts = e.get('points', [])
            if len(pts) > 1:
                e['points'] = [[round((px - sx_off) * sf + dx - xmin * sf + xmin),
                                round((py - sy_off) * sf + dy - ymin * sf + ymin)]
                               for px, py in pts]
        # Round coordinates to avoid floating point noise
        e['x'] = round(e['x'])
        e['y'] = round(e['y'])

    # Update appState to reflect new canvas
    app = data.get('appState', {})
    app['width'] = round(dx + tw + xmin * sf - xmin * sf)
    app['height'] = round(dy + th + ymin * sf - ymin * sf)
    # Simpler: just set canvas bounds
    bxmin = min(e['x'] for e in elements)
    bymin = min(e['y'] for e in elements)
    bxmax = max(e['x'] + e.get('width', 0) if e['type'] in ('text','rectangle','diamond','ellipse')
                else e['x'] + max((p[0] for p in e.get('points',[[0]])), default=0)
                for e in elements)
    bymax = max(e['y'] + e.get('height', 0) if e['type'] in ('text','rectangle','diamond','ellipse')
                else e['y'] + max((p[1] for p in e.get('points',[[0]])), default=0)
                for e in elements)
    canvas_w = bxmax - bxmin
    canvas_h = bymax - bymin
    app['width'] = round(canvas_w / target_ar * target_ar)  # keep it clean
    app['height'] = round(canvas_w / target_ar)
    # Actually, let's set it to exact target proportions
    if canvas_w / max(canvas_h, 1) > target_ar:
        app['width'] = round(canvas_w)
        app['height'] = round(canvas_w / target_ar)
    else:
        app['width'] = round(canvas_h * target_ar)
        app['height'] = round(canvas_h)
    data['appState'] = app
    return True

def main():
    if len(sys.argv) < 2:
        print("Usage: normalize-aspect.py <file.excalidraw> [target_ar]")
        sys.exit(1)
    path = sys.argv[1]
    target_ar = float(sys.argv[2]) if len(sys.argv) > 2 else 1.78
    with open(path) as f:
        data = json.load(f)
    if normalize(data, target_ar):
        with open(path, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        # Compute new AR
        elems = [e for e in data['elements'] if not e.get('isDeleted', False)]
        _, _, _, _, b = get_bounds(elems)
        nw = b[2] - b[0]; nh = b[3] - b[1]
        print(f"  {os.path.basename(path)}: {nw/nh:.2f}")
    else:
        print(f"  {os.path.basename(path)}: already OK (skipped)")

if __name__ == '__main__':
    main()

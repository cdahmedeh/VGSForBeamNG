/* VGS Display — BeamNG UI app
 * ---------------------------------------------------------------------------
 * Draws every wheel where it sits on the vehicle (one body = circle, several
 * coupled bodies = stacked panels, front first).
 *   Inner bar  : grip in use, growing from the centre; solid red = grip exceeded,
 *                greyish red just past the limit, deeper and more saturated as it slides more
 *   Outline    : torque applied — grey neutral, greener with drive, redder with braking
 *   Rotation   : each wheel's live steering angle
 *   Underneath : engine block or electric motors where they sit, gearbox, driveshafts and
 *                differentials (hollow open, centre block limited-slip, solid locked),
 *                tinted by the torque flowing; diamonds on shafts that can disconnect
 *   Rim of the circle : driver inputs — steering (blue) from the top, brake (red)
 *                bottom-left, throttle (green) bottom-right; a quarter turn at full
 *   Yellow dot : G-force felt by the driver (edge = 1.5 g), with a fading trail
 * Click the app to toggle numeric readouts (grip %, slip m/s) for calibration.
 *
 * The renderer is plain canvas and has no BeamNG dependencies, so the same file
 * also runs in the browser preview (VGSRenderer on window).
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var STYLE = {
    neutral:     [128, 134, 145],
    drive:       [70, 225, 95],
    brake:       [255, 60, 50],
    gripFill:    'rgba(236, 240, 246, 0.92)',
    panelFill:   'rgba(12, 14, 18, 0.62)',
    panelStroke: 'rgba(255, 255, 255, 0.22)',
    tyreBg:      'rgba(0, 0, 0, 0.5)',
    broken:      'rgba(160, 160, 160, 0.6)',
    text:        'rgba(255, 255, 255, 0.88)'
  };

  var DRIVETRAIN = {
    axle:       'rgba(255, 255, 255, 0.22)',
    axleIdle:   'rgba(255, 255, 255, 0.12)',   // axle line where nothing drives the wheels
    diffBg:     'rgb(22, 25, 31)',
    gearbox:    'rgba(200, 205, 214, 0.88)',
    axleDriven: 'rgba(255, 255, 255, 0.5)',
    diff:       'rgba(236, 240, 246, 0.75)',
    engine:     'rgba(236, 240, 246, 0.88)',
    engineEdge: 'rgba(0, 0, 0, 0.55)',
    motor:      'rgba(236, 240, 246, 0.88)'
  };


  // Drawing sizes in metres (scaled with the vehicle)
  var TYRE_W = 0.23, TYRE_H = 0.8, PAD = 0.28, BODY_GAP = 0.45;
  // tyres are drawn this much wider than they really are (same length), so they're easy to see
  var TYRE_WIDEN = 1.5;
  var ENGINE_W = 0.62, ENGINE_H = 0.48, MOTOR_R = 0.2, DIFF = 0.2;
  // gearbox and centre-diff placement when the vehicle doesn't locate them (metres)
  var GB_SIZE = 0.34, GB_OFFSET = 0.5, CDIFF_NEAR = 0.75, CDIFF_BACK = 0.4, CDIFF_LEVEL = 0.45;
  var TRANSVERSE_TOL = 0.3;   // engine this close (fore/aft) to a driven axle: mounted sideways
  var AXLE_TOL = 0.3; // wheels within this many metres fore/aft share an axle
  var DUAL_GAP = 0.6;  // same-side wheels on one axle closer than this are a dual set
  var DUAL_GAP_M = 0.04;    // gap between tyres of a dual set when spread from one hub (m)
  var DUAL_SAME_HUB = 0.05; // dual tyres closer than this (m) are treated as reported at one hub point
  var MIN_TYRE_W = 3, MIN_TYRE_L = 6;   // px; only so very small tyres stay visible
  // Assist dots beside the wheels (wheel.iv): 1 = ABS acting on it, 3 = ESC braking it.
  // Small and slightly see-through, so they stay subtle; one per corner (a dual set shares one).
  var ASSIST = {
    1: { colour: 'rgba(255, 85, 75, 0.9)',  rank: 1 },
    3: { colour: 'rgba(95, 165, 255, 0.9)', rank: 2 }
  };
  function dotRadius(tyreW) { return clamp(tyreW * 0.22, 1.8, 3.2); }
  var DOT_SPACE = 0.22;   // room beside the outer wheels for the assist dots (m)

  function toArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return Object.keys(v).map(function (k) { return v[k]; });
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function mix(a, b, t) {
    return 'rgb(' + [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * t); }).join(',') + ')';
  }
  // Sliding fill: a clearly red but washed-out, greyish tone the moment grip breaks,
  // deepening to fully saturated red as the slide grows (wheel.ex, 0..1).
  var SLIDE_LOW = [3, 48, 64], SLIDE_HIGH = [0, 100, 47];   // hue, saturation %, lightness %
  function slideColour(severity) {
    var k = clamp(severity === undefined ? 1 : +severity || 0, 0, 1);
    var hsl = [0, 1, 2].map(function (i) { return SLIDE_LOW[i] + (SLIDE_HIGH[i] - SLIDE_LOW[i]) * k; });
    return 'hsl(' + hsl[0].toFixed(1) + ', ' + hsl[1].toFixed(1) + '%, ' + hsl[2].toFixed(1) + '%)';
  }

  function torqueColour(t) {
    t = clamp(+t || 0, -1, 1);
    return t >= 0 ? mix(STYLE.neutral, STYLE.drive, t) : mix(STYLE.neutral, STYLE.brake, -t);
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);      ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Group wheels into axles (front first).
  function findAxles(wheels) {
    var sorted = wheels.slice().sort(function (a, b) { return b.y - a.y; });
    var axles = [];
    sorted.forEach(function (w) {
      var a = axles[axles.length - 1];
      if (a && Math.abs(a.y - w.y) < AXLE_TOL) {
        a.wheels.push(w);
        a.y = a.wheels.reduce(function (s, x) { return s + +x.y; }, 0) / a.wheels.length;
      } else {
        axles.push({ y: +w.y, wheels: [w] });
      }
    });
    axles.forEach(function (a) {
      var xs = a.wheels.map(function (w) { return +w.x; });
      a.minX = Math.min.apply(null, xs); a.maxX = Math.max.apply(null, xs);
      a.cx = (a.minX + a.maxX) / 2;
      a.driven = a.wheels.some(function (w) { return !!+w.d; });
    });
    return axles;
  }

  // Tyre size in metres: length (top view) = diameter; width = tyre width, widened by TYRE_WIDEN.
  // Dual tyres that would then touch are spread apart (see findTyreSets).
  function tyreDims(w) {
    var r = +w.rd, wd = +w.wd;
    // small wheels are real too (a Pigeon's stabiliser wheels are 8 cm in radius, 2.5 cm wide);
    // only missing or nonsense sizes fall back to the defaults
    w._len = (r > 0.02 && r < 3) ? 2 * r : TYRE_H;
    w._wd = ((wd > 0.005 && wd < 2) ? wd : TYRE_W) * TYRE_WIDEN;
  }

  // Within each axle, group wheels on the same side that sit close together (dual tyres).
  // Tyres reported at their real, separate positions stay there. Tyres that would overlap
  // (several reported at one hub, or one wheel standing in for a pair) are spread side by
  // side, as close as they can be without touching.
  function findTyreSets(axles) {
    axles.forEach(function (a) {
      var sorted = a.wheels.slice().sort(function (p, q) { return (p.x - q.x) || (p.i - q.i); });
      var sets = [];
      sorted.forEach(function (w) {
        var side = +w.x < a.cx - 0.01 ? -1 : (+w.x > a.cx + 0.01 ? 1 : 0);
        var cur = sets[sets.length - 1];
        // a dual set: close together, or close enough that the widened tyres would touch
        // (e.g. a dump truck's duals, each its own wheel pushed apart by wheelOffset)
        var last = cur && cur.wheels[cur.wheels.length - 1];
        if (cur && side !== 0 && cur.side === side &&
            (+w.x - cur.lastX < DUAL_GAP || +w.x - cur.lastX < (last._wd + w._wd) / 2 + DUAL_GAP_M)) {
          cur.wheels.push(w); cur.lastX = +w.x;
        } else {
          sets.push({ side: side, wheels: [w], lastX: +w.x });
        }
      });
      sets.forEach(function (st) {
        var k = st.wheels.length, spread = false, j;
        for (j = 1; j < k; j++) {
          var p = st.wheels[j - 1], q = st.wheels[j];
          if (+q.x - +p.x < (p._wd + q._wd) / 2 + DUAL_GAP_M) spread = true;
        }
        st.spread = spread;
        st.cx = st.wheels.reduce(function (s, w) { return s + +w.x; }, 0) / k;
        st.pitch = Math.max.apply(null, st.wheels.map(function (w) { return w._wd; })) + DUAL_GAP_M;
        // Tyres at separate real positions (e.g. pushed apart by wheelOffset): keep the outer
        // tyre where it really is and move the inner ones inwards, so the outer edge still lines
        // up with the other axles as on the real vehicle (a school bus's front wheels sit in
        // line with the outer dual, a semi tractor's between the two). Tyres reported at one
        // hub point, or one wheel standing in for a pair, spread evenly around that point.
        if (spread && st.side !== 0 &&+st.wheels[k - 1].x - +st.wheels[0].x > DUAL_SAME_HUB) {
          var outer = st.side < 0 ? st.wheels[0] : st.wheels[k - 1];
          st.cx = +outer.x - st.side * (k - 1) / 2 * st.pitch;
        }
        st.wheels.forEach(function (w, n) {
          w._slot = n - (k - 1) / 2;            // position within the set: ..., -0.5, +0.5, ...
          w._mx = spread ? st.cx + w._slot * st.pitch : +w.x;   // drawn x, metres
          w._set = st;
          w._outer = st.side < 0 ? n === 0 : n === k - 1;
        });
      });
      a.sets = sets;
    });
  }

  // ext (optional): the vehicle's whole footprint. When present, the vehicle is centred on
  // and outlined by its real body; otherwise the wheels set the extent.
  function bodyGeometry(wheels, sources, ext) {
    wheels.forEach(tyreDims);
    var axles = findAxles(wheels);
    findTyreSets(axles);
    var i, j;
    // tyres one behind another can't overlap in reality; if reported positions say they
    // would, shorten both just enough to keep them apart
    for (i = 0; i < wheels.length; i++) {
      for (j = i + 1; j < wheels.length; j++) {
        var a = wheels[i], b = wheels[j];
        var dx = Math.abs(a._mx - b._mx), dy = Math.abs(a.y - b.y);
        if (dx < (a._wd + b._wd) / 2 && dy > 0.02 && dy < (a._len + b._len) / 2) {
          a._len = Math.min(a._len, dy * 0.94); b._len = Math.min(b._len, dy * 0.94);
        }
      }
    }
    // extent of the tyres themselves
    var tx0 = Infinity, tx1 = -Infinity, ty0 = Infinity, ty1 = -Infinity;
    wheels.forEach(function (w) {
      tx0 = Math.min(tx0, w._mx - w._wd / 2); tx1 = Math.max(tx1, w._mx + w._wd / 2);
      ty0 = Math.min(ty0, +w.y - w._len / 2); ty1 = Math.max(ty1, +w.y + w._len / 2);
    });
    var hasExt = !!(ext && +ext.x1 > +ext.x0 && +ext.y1 > +ext.y0);
    var box;
    if (hasExt) {
      // Keep the outline symmetric about the vehicle's centreline (the middle of its axles).
      // Bits that stick out on one side only (a haul truck's left mirror and railing, a
      // ladder, an exhaust stack) would otherwise push the wheels off-centre in the box,
      // so each side is cut back to the narrower one.
      var mid = axles.reduce(function (s, a) { return s + a.cx; }, 0) / axles.length;
      var half = Math.min(mid - +ext.x0, +ext.x1 - mid);
      var ex0 = +ext.x0, ex1 = +ext.x1;
      if (axles.length && half > 0) { ex0 = mid - half; ex1 = mid + half; }
      box = { x0: Math.min(ex0, tx0), x1: Math.max(ex1, tx1),
              y0: Math.min(+ext.y0, ty0), y1: Math.max(+ext.y1, ty1) };
    } else {
      var sy0 = ty0, sy1 = ty1;
      sources.forEach(function (s) {
        sy0 = Math.min(sy0, +s.y - ENGINE_H / 2); sy1 = Math.max(sy1, +s.y + ENGINE_H / 2);
      });
      box = { x0: tx0 - PAD / 2, x1: tx1 + PAD / 2, y0: sy0 - PAD / 2, y1: sy1 + PAD / 2 };
    }
    var cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    var boxHalfW = (box.x1 - box.x0) / 2, boxHalfH = (box.y1 - box.y0) / 2;
    // everything that must stay visible, relative to the centre (for stacking and fitting)
    var halfW = boxHalfW, halfH = boxHalfH;
    wheels.forEach(function (w) {
      halfW = Math.max(halfW, Math.abs(w._mx - cx) + w._wd / 2 + DOT_SPACE);
    });
    sources.forEach(function (s) {
      halfH = Math.max(halfH, Math.abs(+s.y - cy) + ENGINE_H / 2);
    });
    return {
      cx: cx, cy: cy, box: box, hasExt: hasExt,
      boxHalfW: boxHalfW, boxHalfH: boxHalfH,
      halfW: halfW, halfH: halfH,
      axles: axles
    };
  }

  // Radius (metres, from the body centre) the circle must hold for a lone vehicle:
  // its body, every tyre at any steering angle, and the engine.
  function fitRadius(body) {
    var g = body.geo;
    var rM = Math.hypot(g.boxHalfW, g.boxHalfH);
    body.wheels.forEach(function (w) {
      var ox = Math.abs(w._mx - g.cx), oy = +w.y - g.cy;
      rM = Math.max(rM,
        Math.hypot(ox, oy) + Math.hypot(w._wd, w._len) / 2,
        Math.hypot(ox + w._wd / 2 + DOT_SPACE, oy));
    });
    body.sources.forEach(function (s) {
      rM = Math.max(rM, Math.hypot(s.x - g.cx, s.y - g.cy) + Math.hypot(ENGINE_W, ENGINE_H) / 2);
    });
    return rM;
  }

  // ----- Drive graph --------------------------------------------------------
  // Nodes { k: 'src'|'gb'|'diff'|'wheel', p: parent index (1-based, 0 = none), ... } in
  // parent-first order (see buildDriveGraph in vgsTelemetry.lua). The shaft from a node's
  // parent can be disconnectable, cp: [{ t: 'dog', o: 1 when disconnected }], with dc = 1
  // while it's disconnected. The vehicle sends it (body.dt); for older data, or the preview,
  // it's built here: a gearbox behind each engine, a differential on each axle a source
  // drives two or more wheels of, and a centre differential when it drives several axles.
  function synthDrivetrain(wheels, sources) {
    var nodes = [], axles = findAxles(wheels);
    function add(n) { nodes.push(n); return nodes.length; }
    toArray(sources).forEach(function (src, si) {
      var ids = toArray(src.w).map(Number);
      var root = add({ k: 'src', si: si, p: 0 });
      var top = src.k === 'ev' ? root : add({ k: 'gb', p: root });
      var groups = [];
      axles.forEach(function (a) {
        var seen = {}, mine = [];
        a.wheels.forEach(function (w) {
          if (ids.indexOf(+w.i) !== -1 && !seen[w.i]) { seen[w.i] = true; mine.push(+w.i); }
        });
        if (mine.length) groups.push(mine);
      });
      var parent = groups.length > 1 ? add({ k: 'diff', p: top, st: 'lsd' }) : top;
      groups.forEach(function (g) {
        var at = g.length > 1 ? add({ k: 'diff', p: parent, st: 'open' }) : parent;
        g.forEach(function (i) { add({ k: 'wheel', w: i, p: at }); });
      });
    });
    return nodes;
  }

  // Positions (metres) for every node. Wheels and axle differentials sit at their wheels;
  // engines where the vehicle puts them; gearboxes and centre differentials where the
  // vehicle's structure names them, otherwise next to the engine / gearbox.
  function placeDrivetrain(body, centreX, sourceX) {
    var raw = toArray(body.dt);
    if (!raw.length) raw = synthDrivetrain(body.wheels, body.sources);
    var nodes = raw.map(function (n) { var c = {}; for (var k in n) c[k] = n[k]; c.kids = []; return c; });
    var wheelById = {};
    body.wheels.forEach(function (w) { if (!(w.i in wheelById)) wheelById[w.i] = w; });
    nodes.forEach(function (n) {
      n.parent = +n.p > 0 ? (nodes[+n.p - 1] || null) : null;
      if (n.parent) n.parent.kids.push(n);
    });
    function under(n) {
      if (n.ws) return n.ws;
      var ws = [];
      if (n.k === 'wheel') { if (wheelById[n.w]) ws.push(wheelById[n.w]); }
      else n.kids.forEach(function (c) { ws = ws.concat(under(c)); });
      return (n.ws = ws);
    }
    function mean(ws, key) { return ws.reduce(function (s, w) { return s + (+w[key] || 0); }, 0) / ws.length; }
    function known(v) { return v !== undefined && v !== null && isFinite(+v); }
    var midY = body.wheels.length ? mean(body.wheels, 'y') : 0;   // middle of the wheelbase

    nodes.forEach(function (n) {
      var ws = under(n);
      if (n.k === 'wheel' && ws.length) { n.x = +ws[0].x; n.y = +ws[0].y; }
      else if (n.k === 'diff' && ws.length) {
        var ys = ws.map(function (w) { return +w.y; });
        if (Math.max.apply(null, ys) - Math.min.apply(null, ys) < AXLE_TOL) {
          n.axle = true; n.x = mean(ws, 'x'); n.y = mean(ws, 'y');
        }
      }
    });
    nodes.forEach(function (n) {
      var P = n.parent;
      n.dead = !!(+n.dc || (P && P.dead));   // disconnected here or further up the line
      if (n.k === 'src') {
        var s = body.sources[+n.si];
        if (!s) return;
        n.src = s; n.x = sourceX(s); n.y = +s.y; n.shift = n.x - +s.x;
        return;
      }
      if (!P || P.x === undefined) return;
      if (n.k === 'gb') {
        // always in line with its engine (on the centreline for an engine drawn there); only
        // the fore/aft position is taken from the vehicle when it locates the transmission
        n.shift = P.shift || 0;
        n.x = P.x;
        if (known(n.gy)) { n.y = +n.gy; return; }
        var ws = under(n), dy = ws.length ? mean(ws, 'y') - P.y : -1;
        // an engine sitting on one of its driven axles is mounted sideways: put the gearbox just
        // behind it, towards the middle of the vehicle; otherwise towards the wheels it drives
        var onAxle = ws.some(function (w) { return Math.abs(+w.y - P.y) < TRANSVERSE_TOL; });
        if (onAxle || Math.abs(dy) < 0.3) dy = midY - P.y;
        n.y = P.y + (dy > 0 ? 1 : -1) * GB_OFFSET;
      } else if (n.k === 'diff' && !n.axle) {
        n.shift = P.shift || 0;
        if (known(n.gx) && known(n.gy)) { n.x = +n.gx + n.shift; n.y = +n.gy; return; }
        var anchors = n.kids.map(function (c) {
          if (c.y !== undefined) return c.y;
          var cw = under(c);
          return cw.length ? mean(cw, 'y') : P.y;
        });
        if (!anchors.length) return;
        var ahead = anchors.some(function (y) { return y > P.y + 0.2; });
        var behind = anchors.some(function (y) { return y < P.y - 0.2; });
        var level = anchors.some(function (y) { return Math.abs(y - P.y) <= 0.2; });
        var farthest = anchors.reduce(function (f, y) { return Math.abs(y - P.y) > Math.abs(f - P.y) ? y : f; }, anchors[0]);
        if (level && (ahead || behind)) {
          // feeds the axle it sits on plus another (transverse-engine AWD): on the centreline
          // just past that axle's diff, towards the other axle
          n.y = P.y + (farthest > P.y ? 1 : -1) * Math.min(CDIFF_LEVEL, Math.abs(farthest - P.y) * 0.4);
        } else if (ahead && behind) {
          // feeds both ends (AWD transfer case): just past the gearbox, towards the far axle
          var far = anchors.reduce(function (f, y) { return Math.abs(y - P.y) > Math.abs(f - P.y) ? y : f; }, anchors[0]);
          n.y = P.y + (far > P.y ? 1 : -1) * Math.min(CDIFF_NEAR, Math.abs(far - P.y) * 0.6);
        } else {
          // feeds axles on one side (truck inter-axle diff): just ahead of the nearest one
          var near = anchors.reduce(function (f, y) { return Math.abs(y - P.y) < Math.abs(f - P.y) ? y : f; }, anchors[0]);
          n.y = near + (P.y > near ? 1 : -1) * Math.min(CDIFF_BACK, Math.abs(P.y - near) / 2);
        }
        n.x = centreX;
      }
    });
    return nodes;
  }

  // combustion engine: block with cylinder-head ribs (outline dashed by the caller when its
  // position is estimated)
  function drawEngine(ctx, p, ew, eh) {
    roundRect(ctx, p.x - ew / 2, p.y - eh / 2, ew, eh, Math.min(4, eh * 0.2));
    ctx.fillStyle = DRIVETRAIN.engine; ctx.fill();
    ctx.strokeStyle = DRIVETRAIN.engineEdge; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'; ctx.lineWidth = 1; ctx.setLineDash([]);
    for (var k = 1; k <= 3; k++) {
      var yy = p.y - eh / 2 + (eh * k) / 4;
      ctx.beginPath(); ctx.moveTo(p.x - ew * 0.32, yy); ctx.lineTo(p.x + ew * 0.32, yy); ctx.stroke();
    }
    ctx.restore();
  }

  // electric motor: ring with a centre dot
  function drawMotor(ctx, p, r) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = DRIVETRAIN.engineEdge; ctx.fill();
    ctx.strokeStyle = DRIVETRAIN.motor; ctx.lineWidth = clamp(r * 0.35, 2, 4); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = DRIVETRAIN.motor; ctx.fill();
  }

  // open: hollow; limited-slip: hollow with a centre block; locked: solid
  function drawDiff(ctx, p, d, st, dead) {
    ctx.save();
    if (dead) ctx.globalAlpha = 0.5;
    var x = p.x - d / 2, y = p.y - d / 2;
    if (st === 'locked') {
      ctx.fillStyle = DRIVETRAIN.diff; ctx.fillRect(x, y, d, d);
      ctx.strokeStyle = DRIVETRAIN.engineEdge; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, d - 1, d - 1);
    } else {
      var lw = clamp(d * 0.16, 1.2, 2);
      ctx.fillStyle = DRIVETRAIN.diffBg; ctx.fillRect(x, y, d, d);
      ctx.strokeStyle = DRIVETRAIN.diff; ctx.lineWidth = lw;
      ctx.strokeRect(x + lw / 2, y + lw / 2, d - lw, d - lw);
      if (st === 'lsd') {
        var c = Math.max(2, d * 0.34);
        ctx.fillStyle = DRIVETRAIN.diff; ctx.fillRect(p.x - c / 2, p.y - c / 2, c, c);
      }
    }
    ctx.restore();
  }

  // gearbox: small block with a shift-gate "H"
  function drawGearbox(ctx, p, size) {
    ctx.save();
    roundRect(ctx, p.x - size / 2, p.y - size / 2, size, size, Math.min(3, size * 0.2));
    ctx.fillStyle = DRIVETRAIN.gearbox; ctx.fill();
    ctx.strokeStyle = DRIVETRAIN.engineEdge; ctx.lineWidth = 1.2; ctx.stroke();
    var g = size * 0.24;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'; ctx.lineWidth = Math.max(1, size * 0.09); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x - g, p.y - g); ctx.lineTo(p.x - g, p.y + g);
    ctx.moveTo(p.x + g, p.y - g); ctx.lineTo(p.x + g, p.y + g);
    ctx.moveTo(p.x - g, p.y);     ctx.lineTo(p.x + g, p.y);
    ctx.stroke();
    ctx.restore();
  }

  // disconnectable shaft (4WD engage, locking hub, axle disconnect), drawn across the shaft
  // at p; (ux, uy) = shaft direction. Solid diamond when connected, hollow when disconnected.
  function drawDisconnect(ctx, p, ux, uy, open, size) {
    var nx = -uy, ny = ux, r = size / 2 * 1.05;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p.x + ux * r, p.y + uy * r); ctx.lineTo(p.x + nx * r, p.y + ny * r);
    ctx.lineTo(p.x - ux * r, p.y - uy * r); ctx.lineTo(p.x - nx * r, p.y - ny * r);
    ctx.closePath();
    ctx.fillStyle = open ? DRIVETRAIN.diffBg : DRIVETRAIN.diff; ctx.fill();
    ctx.strokeStyle = DRIVETRAIN.diff; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
  }

  // Driveshafts, half-shafts, differentials, gearbox and power sources (under the tyres).
  // map(x, y) converts vehicle metres to canvas pixels; s = pixels per metre; tyreBox(w) gives a
  // wheel's drawn tyre in px ({ x, y, hx, hy }: centre, reach across, reach along), so shafts
  // can stop at its edge.
  function drawDrivetrain(ctx, body, map, s, tyreBox) {
    var g = body.geo, axles = g.axles;
    ctx.save();
    ctx.lineCap = 'butt';

    // Car's centreline. Engines sit on it even if the vehicle data puts them slightly
    // off-centre; only a motor that drives wheels on one side keeps its own lateral position.
    var centreX = axles.length
      ? axles.reduce(function (sum, a) { return sum + a.cx; }, 0) / axles.length : g.cx;
    function sourceX(src) {
      var ids = toArray(src.w), left = 0, right = 0;
      body.wheels.forEach(function (w) {
        if (ids.indexOf(w.i) === -1) return;
        if (+w.x < centreX - 0.05) left++; else if (+w.x > centreX + 0.05) right++;
      });
      return (left > 0) !== (right > 0) ? +src.x : centreX;
    }
    var nodes = placeDrivetrain(body, centreX, sourceX);
    var drivenWidth = clamp(0.09 * s, 2, 4.5);
    var ew = clamp(ENGINE_W * s, 12, 34), eh = clamp(ENGINE_H * s, 9, 26);   // engine block (px)
    var diffPx = clamp(DIFF * s, 6, 12), gbPx = clamp(GB_SIZE * s, 9, 18);
    var cpPx = clamp(0.17 * s, 6, 9), motorR = clamp(MOTOR_R * s, 5, 12);

    // Pixel position of every node.
    nodes.forEach(function (n) { if (n.x !== undefined) n.pt = map(n.x, n.y); });

    // Spread the parts out so none overlaps another. Glyphs are drawn larger than life so they
    // stay readable, so at their real spots an engine, its gearbox, a transfer case and the axle
    // diffs can pile up. Engines, motors, gearboxes and centre diffs are nudged fore and aft
    // (never sideways, so they stay on the centreline) until they're clear of each other; axle
    // diffs stay put at the middle of their axle. Everything stays inside the vehicle's outline.
    (function spread() {
      var GAP = 3, items = [];
      nodes.forEach(function (n) {
        if (!n.pt) return;
        var it = { n: n, fixed: false };
        if (n.k === 'src') { if (n.src && n.src.k === 'ev') it.hw = it.hh = motorR; else { it.hw = ew / 2; it.hh = eh / 2; } }
        else if (n.k === 'gb') it.hw = it.hh = gbPx / 2;
        else if (n.k === 'diff') { it.hw = it.hh = diffPx / 2; it.fixed = !!n.axle; }
        else return;
        items.push(it);
      });
      var box = g.box, top = map(g.cx, box.y1).y, bottom = map(g.cx, box.y0).y, midY = (top + bottom) / 2;
      function isAncestor(a, b) { for (var m = b.parent; m; m = m.parent) if (m === a) return true; return false; }
      function wheelsY(n) {
        var ws = n.ws || [];
        return ws.length ? map(0, ws.reduce(function (sum, w) { return sum + +w.y; }, 0) / ws.length).y : midY;
      }
      // which way b should go from a when they sit at the same height: a part further down the
      // drivetrain goes towards the wheels it drives, anything else towards the middle
      function awayDir(a, b) {
        if (isAncestor(a.n, b.n)) return wheelsY(b.n) >= a.n.pt.y ? 1 : -1;
        if (isAncestor(b.n, a.n)) return wheelsY(a.n) >= b.n.pt.y ? -1 : 1;
        return b.n.pt.y <= midY ? (a.n.pt.y <= b.n.pt.y ? 1 : -1) : (a.n.pt.y >= b.n.pt.y ? -1 : 1);
      }
      function clampY(it) {
        var lo = top + it.hh + 2, hi = bottom - it.hh - 2;
        if (lo < hi) it.n.pt.y = clamp(it.n.pt.y, lo, hi);
      }
      function overlap(a, b) {
        return Math.abs(b.n.pt.x - a.n.pt.x) < a.hw + b.hw + GAP - 0.5 &&
               Math.abs(b.n.pt.y - a.n.pt.y) < a.hh + b.hh + GAP - 0.5;
      }
      function relax() {
        for (var iter = 0; iter < 80; iter++) {
          var moved = false;
          for (var i = 0; i < items.length; i++) {
            for (var j = i + 1; j < items.length; j++) {
              var a = items[i], b = items[j];
              if (a.fixed && b.fixed) continue;
              var dx = b.n.pt.x - a.n.pt.x, dy = b.n.pt.y - a.n.pt.y;
              if (Math.abs(dx) >= a.hw + b.hw + GAP) continue;
              var need = a.hh + b.hh + GAP - Math.abs(dy);
              if (need <= 0.01) continue;
              var dir = Math.abs(dy) > 0.5 ? (dy > 0 ? 1 : -1) : awayDir(a, b);   // +1: b goes down
              if (a.fixed) b.n.pt.y += dir * need;
              else if (b.fixed) a.n.pt.y -= dir * need;
              else { a.n.pt.y -= dir * need / 2; b.n.pt.y += dir * need / 2; }
              if (!a.fixed) clampY(a);
              if (!b.fixed) clampY(b);
              moved = true;
            }
          }
          if (!moved) break;
        }
      }
      relax();
      // Parts that still overlap are boxed in, e.g. a rear engine's gearbox squeezed between the
      // rear diff and an engine already at the back of the outline. The one of the pair nearest
      // an axle diff moves to that diff's other side, then everything spreads again. Each part
      // flips at most once, so nothing can flip back and forth.
      function nearestFixed(it) {
        var best = null;
        items.forEach(function (f) {
          if (!f.fixed || Math.abs(f.n.pt.x - it.n.pt.x) >= f.hw + it.hw + GAP) return;
          if (!best || Math.abs(f.n.pt.y - it.n.pt.y) < Math.abs(best.n.pt.y - it.n.pt.y)) best = f;
        });
        return best;
      }
      for (var pass = 0; pass < items.length; pass++) {
        var flip = null;
        for (var i = 0; i < items.length && !flip; i++) {
          for (var j = i + 1; j < items.length && !flip; j++) {
            var a = items[i], b = items[j];
            if ((a.fixed && b.fixed) || !overlap(a, b)) continue;
            [a, b].forEach(function (it) {
              if (it.fixed || it.flipped) return;
              var f = nearestFixed(it);
              if (!f) return;
              var d = Math.abs(f.n.pt.y - it.n.pt.y);
              if (!flip || d < flip.d) flip = { it: it, f: f, d: d };
            });
          }
        }
        if (!flip) break;
        var side = flip.it.n.pt.y >= flip.f.n.pt.y ? -1 : 1;
        flip.it.n.pt.y = flip.f.n.pt.y + side * (flip.it.hh + flip.f.hh + GAP);
        clampY(flip.it);
        flip.it.flipped = true;
        relax();
      }
    })();


    // How far a node's glyph reaches from its centre along direction (ux, uy), in px, so
    // shafts' disconnect marks go on the visible stretch between two glyphs.
    function reach(n, ux, uy) {
      function box(hw, hh) {
        var ax = Math.abs(ux), ay = Math.abs(uy);
        return Math.min(ax > 1e-6 ? hw / ax : Infinity, ay > 1e-6 ? hh / ay : Infinity);
      }
      if (n.k === 'src') return n.src && n.src.k === 'ev' ? motorR : box(ew / 2, eh / 2);
      if (n.k === 'gb') return box(gbPx / 2, gbPx / 2);
      if (n.k === 'diff') return box(diffPx / 2, diffPx / 2);
      if (n.k === 'wheel') { if (tyreBox) return 0; var wr = (n.ws || [])[0]; return wr ? Math.max(wr._wd * s, MIN_TYRE_W) / 2 : 0; }
      return 0;
    }

    // Every shaft of the drive graph, half-shafts out to the wheels included: tinted by the
    // torque going to the wheels below it; grey and dashed when disconnected (or below a
    // disconnection). Only shafts that can disconnect get a diamond: a locking hub's just inside
    // its wheel, any other at the first free spot on the shaft counting from the end it feeds,
    // never on top of another part.
    var marks = [], taken = [];
    nodes.forEach(function (n) {
      if (!n.pt) return;
      var hw = 0, hh = 0;
      if (n.k === 'src') { if (n.src && n.src.k === 'ev') hw = hh = motorR; else { hw = ew / 2; hh = eh / 2; } }
      else if (n.k === 'gb') hw = hh = gbPx / 2;
      else if (n.k === 'diff') hw = hh = diffPx / 2;
      if (hw) taken.push({ x: n.pt.x, y: n.pt.y, hw: hw, hh: hh });
    });
    function free(p, h) {
      return !taken.some(function (r) {
        return Math.abs(p.x - r.x) < r.hw + h + 1 && Math.abs(p.y - r.y) < r.hh + h + 1;
      });
    }
    nodes.forEach(function (n) {
      var P = n.parent;
      if (!P || !n.pt || !P.pt) return;
      var a = P.pt, b = (n.k === 'wheel' && P.k === 'diff' && P.axle) ? { x: n.pt.x, y: P.pt.y } : n.pt;
      // Shafts are never drawn diagonally: one that has to go both along and across the
      // vehicle runs fore/aft from the part feeding it first (along the centreline, for a
      // centre part), then turns square and runs across to the part it feeds.
      var pts = [a];
      if (Math.abs(b.x - a.x) > 0.5 && Math.abs(b.y - a.y) > 0.5) pts.push({ x: a.x, y: b.y });
      pts.push(b);
      // A shaft to a wheel stops flush at the tyre's inner edge, not at the middle of the tyre.
      // Across the vehicle it stops at the inside of the whole set (the inner tyre of a dual);
      // along it (a centre wheel), at the tyre's end.
      var w0 = n.k === 'wheel' && tyreBox ? (n.ws || [])[0] : null;
      if (w0) {
        var from = pts[pts.length - 2], end = { x: b.x, y: b.y };
        var boxes = (w0._set ? w0._set.wheels : [w0]).map(tyreBox), own = tyreBox(w0);
        if (Math.abs(from.y - b.y) <= 0.5) {
          var toRight = from.x < own.x;
          end.x = toRight
            ? Math.min.apply(null, boxes.map(function (t) { return t.x - t.hx; }))
            : Math.max.apply(null, boxes.map(function (t) { return t.x + t.hx; }));
          if (toRight ? end.x < from.x : end.x > from.x) end.x = from.x;   // tyre over the part feeding it
        } else {
          end.x = own.x;
          if (pts.length > 2) pts[pts.length - 2].x = own.x;
          var down = from.y < own.y;
          end.y = own.y + (down ? -own.hy : own.hy);
          if (down ? end.y < from.y : end.y > from.y) end.y = from.y;
        }
        pts[pts.length - 1] = end;
      }
      var segs = [], len = 0;
      for (var q = 1; q < pts.length; q++) {
        var sl = Math.hypot(pts[q].x - pts[q - 1].x, pts[q].y - pts[q - 1].y);
        if (sl < 0.01) continue;
        segs.push({ a: pts[q - 1], len: sl, ux: (pts[q].x - pts[q - 1].x) / sl, uy: (pts[q].y - pts[q - 1].y) / sl, at: len });
        len += sl;
      }
      if (len < 0.5) return;
      // point and direction at distance d along the shaft
      function at(d) {
        var sg = segs[segs.length - 1];
        for (var q = 0; q < segs.length; q++) if (d <= segs[q].at + segs[q].len) { sg = segs[q]; break; }
        var t = d - sg.at;
        return { x: sg.a.x + sg.ux * t, y: sg.a.y + sg.uy * t, ux: sg.ux, uy: sg.uy };
      }
      var first = segs[0], last = segs[segs.length - 1];
      var ws = n.ws || [];
      var torque = ws.length ? ws.reduce(function (sum, w) { return sum + (+w.dr || 0); }, 0) / ws.length : 0;
      ctx.save();
      if (n.dead) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = DRIVETRAIN.axle; ctx.lineWidth = Math.max(1.5, drivenWidth * 0.7);
      } else {
        ctx.strokeStyle = torqueColour(torque * 0.7); ctx.lineWidth = drivenWidth;
      }
      ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (var q2 = 1; q2 < pts.length; q2++) ctx.lineTo(pts[q2].x, pts[q2].y);
      ctx.stroke();
      ctx.restore();

      var v0 = Math.min(reach(P, first.ux, first.uy), len), v1 = Math.max(v0, len - reach(n, -last.ux, -last.uy));
      var h = cpPx * 0.65, cursor = v1 - h;
      // a locking hub's diamond goes right next to its wheel
      if (n.k === 'wheel') {
        toArray(n.cp).forEach(function (c) {
          var p = at(v1 - h - 2);
          taken.push({ x: p.x, y: p.y, hw: h, hh: h });
          marks.push({ p: p, ux: p.ux, uy: p.uy, open: !!+c.o });
        });
        return;
      }
      toArray(n.cp).forEach(function (c) {
        var spot = null;
        for (var d = cursor; d >= v0 + h; d -= 1) {
          if (free(at(d), h)) { spot = d; break; }
        }
        if (spot === null) spot = Math.max(v0, v1 - h);   // nowhere free: next to the part it feeds
        var p = at(spot);
        taken.push({ x: p.x, y: p.y, hw: h, hh: h });
        marks.push({ p: p, ux: p.ux, uy: p.uy, open: !!+c.o });
        cursor = spot - 2 * h - 1;
      });
    });

    // Engines, then gearboxes, then differentials on top (a transaxle's diff is inside the gearbox, and an
    // engine sitting over its driven axle mustn't hide the lock state), then electric motors.
    function drawSource(src, ev) {
      var sn = nodes.filter(function (n) { return n.k === 'src' && n.src === src && n.pt; })[0];
      var p = sn ? sn.pt : map(sourceX(src), +src.y);
      ctx.save();
      ctx.setLineDash(+src.e ? [3, 2] : []);
      if (ev) drawMotor(ctx, p, motorR);
      else drawEngine(ctx, p, ew, eh);
      ctx.restore();
    }
    body.sources.forEach(function (src) { if (src.k !== 'ev') drawSource(src, false); });
    nodes.forEach(function (n) { if (n.k === 'gb' && n.pt) drawGearbox(ctx, n.pt, gbPx); });
    nodes.forEach(function (n) { if (n.k === 'diff' && n.pt) drawDiff(ctx, n.pt, diffPx, n.st, n.dead); });
    body.sources.forEach(function (src) { if (src.k === 'ev') drawSource(src, true); });
    // disconnect diamonds last among the parts, so none is ever hidden under one
    marks.forEach(function (m) { drawDisconnect(ctx, m.p, m.ux, m.uy, m.open, cpPx); });


    ctx.restore();
  }

  // Driver inputs on the rim of the circle, a quarter turn each at full input:
  // steering from 12 o'clock towards 9 (left) or 3 (right); brake from 6 towards 9;
  // throttle from 6 towards 3. Nothing is drawn at rest.
  // Direction of travel: a small marker just inside the steering arc, on the same scale (a quarter
  // turn = full lock), where the front axle is actually going. Steering at the marker points the
  // front wheels exactly where they're travelling. It goes on round the circle in big slides.
  // The marker's colour shows the balance: light blue when neutral, orange as the front slides
  // more than the rear (understeer), magenta as the rear slides more (oversteer).
  var TRAVEL_COLOUR = { neutral: [150, 210, 245], under: [255, 150, 45], over: [235, 70, 205] };
  function travelColour(bal) {
    var b = clamp(+bal || 0, -1, 1), to = b < 0 ? TRAVEL_COLOUR.under : TRAVEL_COLOUR.over, k = Math.abs(b);
    return 'rgb(' + TRAVEL_COLOUR.neutral.map(function (c, i) { return Math.round(c + (to[i] - c) * k); }).join(', ') + ')';
  }
  var INPUT = {
    steer:     'rgb(45, 115, 205)',
    brake:     'rgb(205, 45, 40)',
    throttle:  'rgb(60, 180, 75)',
    brakePulse:    'rgb(240, 80, 70)',     // the brake arc pulses a little brighter while ABS works
    throttlePulse: 'rgb(30, 110, 45)',     // the throttle arc dips a little darker while TCS cuts power
    clutch:    'rgb(225, 229, 236)',   // over the throttle, on the outer half of the rim
    handbrake: 'rgb(135, 22, 58)'      // dark crimson / wine, over the brake, on the outer half of the rim
  };
  var PULSE_HZ = 5;       // how fast the brake / throttle arcs pulse while ABS / TCS work
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function mixRgb(a, b, k) {
    var pa = a.match(/[\d.]+/g).map(Number), pb = b.match(/[\d.]+/g).map(Number);
    return 'rgb(' + [0, 1, 2].map(function (i) { return Math.round(pa[i] + (pb[i] - pa[i]) * k); }).join(', ') + ')';
  }
  function markerSize(rPx) { return clamp(rPx * 0.085, 7, 14); }          // marker height (px)
  function drawInputArcs(ctx, cx, cy, rPx, inp) {
    if (!inp) return;
    var lw = clamp(rPx * 0.05, 3, 7), r = rPx - lw / 2, Q = Math.PI / 2, TOP = -Q, BOTTOM = Q;
    var steer = clamp(+inp.s || 0, -1, 1), thr = clamp(+inp.t || 0, 0, 1), brk = clamp(+inp.b || 0, 0, 1);
    function arc(colour, from, to) {
      if (to - from < 0.004) return;
      ctx.beginPath(); ctx.arc(cx, cy, r, from, to);
      ctx.strokeStyle = colour; ctx.stroke();
    }
    ctx.save();
    // direction of travel (see above), drawn on top at the end
    var hasTravel = inp.tv !== undefined && inp.tv !== null;
    var tv = hasTravel ? clamp(+inp.tv || 0, -4, 4) : 0, alpha = clamp(inp.ta === undefined ? 1 : +inp.ta, 0, 1);
    ctx.lineWidth = lw; ctx.lineCap = 'butt';
    if (steer > 0) arc(INPUT.steer, TOP - steer * Q, TOP);        // left: counter-clockwise from the top
    else if (steer < 0) arc(INPUT.steer, TOP, TOP - steer * Q);   // right: clockwise from the top
    // ABS working: the brake arc pulses; traction control working: the throttle arc pulses
    var pulse = 0.5 + 0.5 * Math.sin(nowMs() / 1000 * 2 * Math.PI * PULSE_HZ);
    arc(+inp.abs ? mixRgb(INPUT.brake, INPUT.brakePulse, pulse) : INPUT.brake, BOTTOM, BOTTOM + brk * Q);
    arc(+inp.tcs ? mixRgb(INPUT.throttle, INPUT.throttlePulse, pulse) : INPUT.throttle, BOTTOM - thr * Q, BOTTOM);
    // clutch and handbrake: half as wide, along the outer edge, over the throttle and brake
    var clu = clamp(+inp.c || 0, 0, 1), hb = clamp(+inp.p || 0, 0, 1);
    r = rPx - lw / 4; ctx.lineWidth = lw / 2;
    arc(INPUT.handbrake, BOTTOM, BOTTOM + hb * Q);
    arc(INPUT.clutch, BOTTOM - clu * Q, BOTTOM);
    // the marker: a small wedge pointing out at the steering arc, where the front is going
    if (hasTravel && alpha > 0) {
      var ang = TOP - tv * Q, mh = markerSize(rPx), tip = rPx - lw - 0.5, base = tip - mh, half = mh * 0.5;
      var ux = Math.cos(ang), uy = Math.sin(ang), px = -uy, py = ux;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(cx + ux * tip, cy + uy * tip);
      ctx.lineTo(cx + ux * base + px * half, cy + uy * base + py * half);
      ctx.lineTo(cx + ux * base - px * half, cy + uy * base - py * half);
      ctx.closePath();
      ctx.fillStyle = travelColour(inp.bal);
      ctx.strokeStyle = 'rgba(10, 12, 16, 0.7)'; ctx.lineWidth = 1; ctx.lineJoin = 'round';
      ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // G-force dot: the force the driver feels (braking pushes it forward/up, a left turn
  // pushes it right). The circle's edge is GF_MAX. Recent positions are redrawn as
  // fading ghosts, like a mouse trail, so the dot leaves a path.
  var GF_MAX = 1.5;          // g at the edge of the circle (road cars peak around 1 g)
  var TRAIL_MS = 1300;       // how long a ghost takes to fade out completely
  var GF_COLOUR = [240, 215, 130];   // soft butter yellow, to sit with the muted drivetrain colours
  var GF_ALPHA = 0.5;                 // see-through, so the part underneath still shows
  var GF_RIM_ALPHA = 0.65;            // the rim is a little stronger so the dot keeps its shape

  function drawGForce(ctx, trail, cx, cy, R, gf) {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var gx = +gf.x || 0, gy = +gf.y || 0, mag = Math.hypot(gx, gy);
    if (mag > GF_MAX) { gx *= GF_MAX / mag; gy *= GF_MAX / mag; }   // pin to the edge
    // positions are stored as fractions of the radius so a resize doesn't smear the trail
    trail.push({ x: gx / GF_MAX, y: -gy / GF_MAX, t: now });
    while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();

    var dotR = clamp(R * 0.05, 3, 7.5), reach = R - dotR - 2;
    var rgb = GF_COLOUR.join(', ');
    var head = trail[trail.length - 1];
    ctx.save();
    // Ghosts, oldest first. A ghost sitting on the dot or on the previous ghost is skipped:
    // while the dot holds still they would pile up and their opacity would add up until the
    // dot looked solid.
    var minStep = dotR * 0.6 / reach, lastX = Infinity, lastY = Infinity;
    for (var k = 0; k < trail.length - 1; k++) {
      var tk = trail[k];
      if (Math.hypot(tk.x - head.x, tk.y - head.y) < dotR / reach) continue;
      if (Math.hypot(tk.x - lastX, tk.y - lastY) < minStep) continue;
      lastX = tk.x; lastY = tk.y;
      var life = 1 - (now - tk.t) / TRAIL_MS;
      ctx.fillStyle = 'rgba(' + rgb + ', ' + (GF_ALPHA * 0.8 * life * life).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(cx + tk.x * reach, cy + tk.y * reach, dotR * (0.7 + 0.3 * life), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(cx + head.x * reach, cy + head.y * reach, dotR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(' + rgb + ', ' + GF_ALPHA + ')'; ctx.fill();
    ctx.strokeStyle = 'rgba(' + rgb + ', ' + GF_RIM_ALPHA + ')'; ctx.lineWidth = 1; ctx.stroke();   // thin rim
    ctx.restore();
  }

  function drawEmpty(ctx, W, H) {
    var r = Math.min(W, H) / 2 - 2;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = STYLE.panelFill; ctx.fill();
    ctx.strokeStyle = STYLE.panelStroke; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 ' + clamp(r * 0.16, 10, 18) + 'px sans-serif';
    ctx.fillText('VGS', W / 2, H / 2 - r * 0.08);
    ctx.font = clamp(r * 0.09, 8, 12) + 'px sans-serif';
    ctx.fillText('waiting for vehicle', W / 2, H / 2 + r * 0.12);
  }

  // One dot per axle side, outboard of the outermost wheel there (so dual wheels share a dot).
  // wheelPoint(w) gives a wheel's drawn centre in pixels; dims(w) its drawn size { w, h }.
  function drawAssistDots(ctx, body, wheelPoint, dims) {
    body.geo.axles.forEach(function (a) {
      var sides = { left: [], right: [] };
      a.wheels.forEach(function (w) { (w._set.side < 0 ? sides.left : sides.right).push(w); });
      ['left', 'right'].forEach(function (side) {
        var group = sides[side];
        if (!group.length) return;
        var best = null;
        group.forEach(function (w) {
          var info = ASSIST[+w.iv];
          if (info && (!best || info.rank > best.rank)) best = info;
        });
        if (!best) return;
        var points = group.map(function (w) { return { w: w, p: wheelPoint(w) }; });
        var outer = points.reduce(function (o, q) {
          return (side === 'left' ? q.p.x < o.p.x : q.p.x > o.p.x) ? q : o;
        }, points[0]);
        var p = outer.p, d = dims(outer.w);
        var r = dotRadius(d.w), gap = Math.max(3, r);
        // clear the tyre even when it's steered
        var reach = d.w / 2 + Math.abs(Math.sin(+outer.w.s || 0)) * d.h / 2 + gap + r;
        ctx.save();
        ctx.fillStyle = best.colour;
        ctx.beginPath(); ctx.arc(p.x + (side === 'left' ? -reach : reach), p.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
    });
  }

  function drawTyre(ctx, x, y, w, h, wh, onLeft, opts) {
    var broken = !!+wh.b, sliding = !!+wh.e;
    var rawGrip = +wh.g || 0, grip = clamp(rawGrip, 0, 1);
    var lw = clamp(w * 0.16, 1, 3.5);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-(+wh.s || 0)); // + steer = left = counter-clockwise on screen

    ctx.fillStyle = STYLE.tyreBg;
    ctx.fillRect(-w / 2, -h / 2, w, h);

    if (!broken) {
      var inset = w > 8 ? 2 : 1;
      var iw = w - lw * 2 - inset, ih = h - lw * 2 - inset;
      if (iw > 0 && ih > 0) {
        var fh = sliding ? ih : ih * grip;   // grows from the centre outward
        ctx.fillStyle = sliding ? slideColour(wh.ex) : STYLE.gripFill;
        ctx.fillRect(-iw / 2, -fh / 2, iw, fh);
      }
    }

    ctx.lineWidth = lw;
    ctx.strokeStyle = broken ? STYLE.broken : torqueColour(wh.t);
    if (broken) ctx.setLineDash([3, 3]);
    ctx.strokeRect(-w / 2 + lw / 2, -h / 2 + lw / 2, w - lw, h - lw);
    ctx.restore();

    // Readout beside the outermost tyre of each corner; a dual set shows its worst tyre.
    if (opts.numbers && wh._outer !== false) {
      var set = wh._set ? wh._set.wheels : [wh];
      rawGrip = Math.max.apply(null, set.map(function (s) { return +s.g || 0; }));
      var slipMax = Math.max.apply(null, set.map(function (s) { return +s.sl || 0; }));
      var fs = clamp(h * 0.26, 8, 12);
      ctx.save();
      ctx.font = '600 ' + fs + 'px sans-serif';
      ctx.fillStyle = STYLE.text;
      ctx.textBaseline = 'middle';
      ctx.textAlign = onLeft ? 'right' : 'left';
      var r = dotRadius(w);   // leave room for the assist dot (same reach as drawAssistDots)
      var clear = w / 2 + Math.abs(Math.sin(+wh.s || 0)) * h / 2 + Math.max(3, r) + 2 * r + 4;
      var tx = onLeft ? x - clear : x + clear;
      ctx.fillText(Math.round(rawGrip * 100) + '%', tx, y - fs * 0.6);
      if (wh.sl !== undefined) {
        ctx.font = fs * 0.85 + 'px sans-serif';
        ctx.fillText(slipMax.toFixed(1) + ' m/s', tx, y + fs * 0.6);
      }
      ctx.restore();
    }
  }

  function VGSRenderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.gTrail = [];
  }

  VGSRenderer.prototype.fit = function () {
    var c = this.canvas, dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth || c.width, h = c.clientHeight || c.height;
    var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  };

  VGSRenderer.prototype.draw = function (data, opts) {
    opts = opts || {};
    var size = this.fit(), ctx = this.ctx, W = size.w, H = size.h;
    var trail = this.gTrail;
    ctx.clearRect(0, 0, W, H);

    var bodies = toArray(data && data.bodies)
      .map(function (b) {
        var wheels = [];
        toArray(b.wheels).forEach(function (w, k) {
          if (w.i === undefined) w.i = k;   // older payloads without ids
          // a wheel standing in for a dual pair (w.nt = 2) is drawn as that many tyres;
          // they share its data and are laid out side by side like any dual set
          var n = clamp(Math.round(+w.nt || 1), 1, 4);
          for (var c = 0; c < n; c++) wheels.push(c === 0 ? w : Object.assign({}, w));
        });
        return { wheels: wheels, sources: toArray(b.sources), inp: b.inp, gf: b.gf, ext: b.ext, dt: b.dt };
      })
      .filter(function (b) { return b.wheels.length > 0; });
    if (!bodies.length) { trail.length = 0; drawEmpty(ctx, W, H); return; }
    if (!bodies[0].gf) trail.length = 0;
    // every vehicle is laid out from its real footprint when the vehicle reports one
    bodies.forEach(function (b) { b.geo = bodyGeometry(b.wheels, b.sources, b.ext); });

    var scale, placements = [];
    // The big circle is always drawn at the same size; vehicles are scaled to fit inside it,
    // clear of the input arcs on its rim.
    var rPx = Math.min(W, H) / 2 - 2, ccx = W / 2, ccy = H / 2;
    // vehicles stay inside the steering arc and the travel arc just inside it
    var inner = rPx - clamp(rPx * 0.05, 3, 7) - markerSize(rPx) - 2;
    ctx.beginPath(); ctx.arc(ccx, ccy, rPx, 0, Math.PI * 2);
    ctx.fillStyle = STYLE.panelFill; ctx.fill();
    ctx.strokeStyle = STYLE.panelStroke; ctx.lineWidth = 1.5; ctx.stroke();
    drawInputArcs(ctx, ccx, ccy, rPx, bodies[0].inp);

    function outline(b, ox, oy) {
      var hw = b.geo.boxHalfW * scale, hh = b.geo.boxHalfH * scale;
      roundRect(ctx, ox - hw, oy - hh, hw * 2, hh * 2, Math.min(6, hw * 0.2));
      ctx.strokeStyle = STYLE.panelStroke; ctx.lineWidth = 1; ctx.stroke();
    }

    if (bodies.length === 1) {
      // centred on the vehicle's body, one scale for everything (true proportions)
      scale = inner / fitRadius(bodies[0]);
      if (bodies[0].geo.hasExt) outline(bodies[0], ccx, ccy);
      placements.push({ body: bodies[0], ox: ccx, oy: ccy });
    } else {
      // tractor + trailer, articulated sections: stacked front to back, one shared scale
      var maxHalfW = 0, totalH = BODY_GAP * (bodies.length - 1);
      bodies.forEach(function (b) { maxHalfW = Math.max(maxHalfW, b.geo.halfW); totalH += b.geo.halfH * 2; });
      scale = inner / Math.hypot(maxHalfW, totalH / 2);
      var y = ccy - totalH * scale / 2, prevBottom = null;
      bodies.forEach(function (b) {
        var hh = b.geo.halfH * scale, oy = y + hh;
        if (prevBottom !== null) {           // hitch
          ctx.beginPath(); ctx.moveTo(ccx, prevBottom); ctx.lineTo(ccx, oy - b.geo.boxHalfH * scale);
          ctx.strokeStyle = STYLE.panelStroke; ctx.lineWidth = 2; ctx.stroke();
        }
        outline(b, ccx, oy);
        placements.push({ body: b, ox: ccx, oy: oy });
        prevBottom = oy + b.geo.boxHalfH * scale;
        y = oy + hh + BODY_GAP * scale;
      });
    }

    // Pass 1: drivetrains. Then the G-force dot (centred on the circle, from the lead vehicle).
    // Pass 2: tyres and assist dots on top.
    var dims = function (wh) {
      return { w: Math.max(wh._wd * scale, MIN_TYRE_W), h: Math.max(wh._len * scale, MIN_TYRE_L) };
    };
    placements.forEach(function (p) {
      var g = p.body.geo;
      var map = p.map = function (x, y) {   // vehicle metres → canvas pixels, forward = up
        return { x: p.ox + (x - g.cx) * scale, y: p.oy - (y - g.cy) * scale };
      };
      p.wheelPoint = function (wh) {
        var st = wh._set;
        if (!st.spread) return map(wh._mx, +wh.y);
        // spread sets: real pitch, but never closer than a hairline when tyres are tiny
        var widest = Math.max.apply(null, st.wheels.map(function (s) { return dims(s).w; }));
        var c = map(st.cx, +wh.y);
        return { x: c.x + wh._slot * Math.max(st.pitch * scale, widest + 1.5), y: c.y };
      };
      drawDrivetrain(ctx, p.body, map, scale, function (wh) {
        // hx, hy: how far the (possibly steered) tyre reaches from its centre across and along
        var pt = p.wheelPoint(wh), d = dims(wh), st = +wh.s || 0;
        var c = Math.abs(Math.cos(st)), sn = Math.abs(Math.sin(st));
        return { x: pt.x, y: pt.y,
                 hx: Math.min(c > 1e-6 ? d.w / 2 / c : Infinity, sn > 1e-6 ? d.h / 2 / sn : Infinity),
                 hy: Math.min(c > 1e-6 ? d.h / 2 / c : Infinity, sn > 1e-6 ? d.w / 2 / sn : Infinity) };
      });
    });
    if (bodies[0].gf) drawGForce(ctx, trail, ccx, ccy, rPx, bodies[0].gf);

    placements.forEach(function (p) {
      var wheelPoint = p.wheelPoint;
      p.body.wheels.forEach(function (wh) {
        var pt = wheelPoint(wh), d = dims(wh);
        drawTyre(ctx, pt.x, pt.y, d.w, d.h, wh, wh._set.side < 0, opts);
      });
      drawAssistDots(ctx, p.body, wheelPoint, dims);
    });
  };

  VGSRenderer.synthDrivetrain = synthDrivetrain;   // used by the browser preview
  // the drivetrain glyphs, for the preview's legend and the README's legend image
  VGSRenderer.glyphs = {
    engine: drawEngine, motor: drawMotor,
    diff: drawDiff, gearbox: drawGearbox, disconnect: drawDisconnect,
    colours: DRIVETRAIN, torqueColour: torqueColour,
    tyre: drawTyre, slideColour: slideColour, inputArcs: drawInputArcs, travelColour: travelColour
  };
  window.VGSRenderer = VGSRenderer;

  // ----- BeamNG app directive (skipped when running in a plain browser) -----
  if (!window.angular) return;

  angular.module('beamng.apps')
  .directive('vgsDisplay', [function () {
    return {
      template:
        // no bngApp class: it paints a dark box behind the app; we only want the circle
        '<div style="width:100%; height:100%; position:relative; cursor:pointer; background:transparent;">' +
          '<canvas style="width:100%; height:100%; display:block;"></canvas>' +
        '</div>',
      replace: true,
      restrict: 'EA',
      scope: true,
      link: function (scope, element) {
        var canvas = element[0].querySelector('canvas');
        var renderer = new VGSRenderer(canvas);
        var opts = { numbers: false };
        var last = null, lastTime = 0;

        function enableHub() {
          bngApi.engineLua('extensions.load("vgsHub") if extensions.vgsHub then extensions.vgsHub.setEnabled(true) end');
        }
        enableHub();
        renderer.draw(null, opts);

        // Re-enable the hub if data stops (level change, Lua reload, another instance closed)
        var watchdog = setInterval(function () {
          if (Date.now() - lastTime > 2000) {
            enableHub();
            last = null;
            renderer.draw(null, opts);
          }
        }, 1000);

        scope.$on('VGSUpdate', function (event, data) {
          last = data; lastTime = Date.now();
          renderer.draw(data, opts);
        });

        element.on('click', function () {
          opts.numbers = !opts.numbers;
          renderer.draw(last, opts);
        });

        scope.$on('$destroy', function () {
          clearInterval(watchdog);
          bngApi.engineLua('if extensions.vgsHub then extensions.vgsHub.setEnabled(false) end');
        });
      }
    };
  }]);
})();

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
 * Click the app for the numbers mode: readouts by every corner (grip, slip angle and ratio,
 * load) and, when the app is wide or tall enough, a panel with the whole vehicle's numbers.
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
    airborne:    'rgb(40, 130, 235)',   // inside of a wheel that's off the ground: a strong blue, unlike the white grip bar and the slide reds
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
  var ENGINE_W = 0.62, ENGINE_H = 0.48, MOTOR_R = 0.085, DIFF = 0.2;
  // gearbox and centre-diff placement when the vehicle doesn't locate them (metres)
  var GB_SIZE = 0.34, GB_OFFSET = 0.5, CDIFF_NEAR = 0.75, CDIFF_BACK = 0.4, CDIFF_LEVEL = 0.45;
  var TRANSVERSE_TOL = 0.3;   // engine this close (fore/aft) to a driven axle: mounted sideways
  var AXLE_TOL = 0.3; // wheels within this many metres fore/aft share an axle
  var DUAL_GAP = 0.6;  // same-side wheels on one axle closer than this are a dual set
  var DUAL_GAP_M = 0.04;    // gap between tyres of a dual set when spread from one hub (m)
  var DUAL_SAME_HUB = 0.05; // dual tyres closer than this (m) are treated as reported at one hub point
  var MIN_TYRE_W = 3, MIN_TYRE_L = 6;   // px; only so very small tyres stay visible
  // Assist dots beside the wheels (wheel.iv): 1 = ABS acting on it, 2 = traction control acting
  // on it (driving-dynamics cars), 3 = ESC braking it. Small and slightly see-through, so they
  // stay subtle; one per corner (a dual set shares one, the highest rank showing).
  var ASSIST = {
    1: { colour: 'rgba(255, 85, 75, 0.9)',  rank: 1 },
    2: { colour: 'rgba(80, 220, 120, 0.9)', rank: 1.5 },
    3: { colour: 'rgba(95, 165, 255, 0.9)', rank: 2 }
  };
  function dotRadius(tyreW) { return clamp(tyreW * 0.22, 1.8, 3.2); }
  // Classic traction control intervening on an engine's or motor's wheels (src.tc): a green dot
  // at its centre, the same green as the traction-control wheel dots, with a thin dark edge so
  // it shows on the light block.
  function drawTcDot(ctx, p, r) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = ASSIST[2].colour; ctx.fill();
    ctx.strokeStyle = 'rgba(10, 12, 16, 0.75)'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.restore();
  }
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
    ctx.strokeStyle = DRIVETRAIN.motor; ctx.lineWidth = clamp(r * 0.3, 1.2, 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.3, 0, Math.PI * 2);
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
    var cpPx = clamp(0.17 * s, 6, 9), motorR = clamp(MOTOR_R * s, 3, 5.5);

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
    var tcDots = [];
    function drawSource(src, ev) {
      var sn = nodes.filter(function (n) { return n.k === 'src' && n.src === src && n.pt; })[0];
      var p = sn ? sn.pt : map(sourceX(src), +src.y);
      ctx.save();
      ctx.setLineDash(+src.e ? [3, 2] : []);
      if (ev) drawMotor(ctx, p, motorR);
      else drawEngine(ctx, p, ew, eh);
      ctx.restore();
      if (+src.tc) tcDots.push({ p: p, r: ev ? clamp(motorR * 0.5, 1.6, 3) : clamp(Math.min(ew, eh) * 0.17, 2, 3.6) });
    }
    body.sources.forEach(function (src) { if (src.k !== 'ev') drawSource(src, false); });
    nodes.forEach(function (n) { if (n.k === 'gb' && n.pt) drawGearbox(ctx, n.pt, gbPx); });
    nodes.forEach(function (n) { if (n.k === 'diff' && n.pt) drawDiff(ctx, n.pt, diffPx, n.st, n.dead); });
    body.sources.forEach(function (src) { if (src.k === 'ev') drawSource(src, true); });
    // disconnect diamonds last among the parts, so none is ever hidden under one
    marks.forEach(function (m) { drawDisconnect(ctx, m.p, m.ux, m.uy, m.open, cpPx); });
    // traction-control dots on top of everything, so no part can hide one
    tcDots.forEach(function (d) { drawTcDot(ctx, d.p, d.r); });


    ctx.restore();
  }

  // Driver inputs on the rim of the circle, a quarter turn each at full input:
  // steering from 12 o'clock towards 9 (left) or 3 (right); brake from 6 towards 9;
  // throttle from 6 towards 3. Nothing is drawn at rest.
  // Direction of travel: a small marker just inside the steering arc, on the same scale (a quarter
  // turn = full lock), where the front axle is actually going. Steering at the marker points the
  // front wheels exactly where they're travelling. It goes on round the circle in big slides.
  // The marker's colour shows the balance: light blue when neutral. Oversteer (the rear sliding
  // more) goes towards magenta, or towards aquamarine for a controlled drift (inp.dc, 0..1: the
  // countersteer matching the slide and the slide not growing; see TUNE.DRIFT_* in
  // vgsTelemetry.lua). Aquamarine: a "good, in control" green that doesn't clash with the
  // throttle arc or drive outlines, and the colour that stays most distinct from magenta, the
  // light blue and the oranges with the common kinds of colour blindness (checked by simulation). Understeer comes in two stages: up to UNDER_WARN of the scale is the
  // warning as the front nears its limit, light blue to a light orange; beyond it is understeer
  // proper, the front past its peak, light orange deepening to full orange.
  var TRAVEL_COLOUR = { neutral: [150, 210, 245], warn: [250, 200, 140], under: [255, 150, 45], over: [235, 70, 205], drift: [140, 255, 224] };
  var UNDER_WARN = 0.35;   // must match US_WARN_SHARE in vgsTelemetry.lua
  function travelColour(bal, drift) {
    var b = clamp(+bal || 0, -1, 1), k = Math.abs(b), from = TRAVEL_COLOUR.neutral, to = TRAVEL_COLOUR.over;
    if (b > 0 && +drift > 0) {   // oversteer: magenta, aquamarine for a controlled drift
      var dc = clamp(+drift, 0, 1), o = TRAVEL_COLOUR.over, dr = TRAVEL_COLOUR.drift;
      to = [0, 1, 2].map(function (i) { return o[i] + (dr[i] - o[i]) * dc; });
    }
    if (b < 0) {
      if (k <= UNDER_WARN) { to = TRAVEL_COLOUR.warn; k = k / UNDER_WARN; }
      else { from = TRAVEL_COLOUR.warn; to = TRAVEL_COLOUR.under; k = (k - UNDER_WARN) / (1 - UNDER_WARN); }
    }
    return 'rgb(' + from.map(function (c, i) { return Math.round(c + (to[i] - c) * k); }).join(', ') + ')';
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
  // Steering scale for the steering arc and the direction marker: asinh(k x) / asinh(k), the
  // centre stretched and full lock still at a quarter turn. Both use the same curve, so which is
  // further round, and whether they line up, are exactly as on a straight scale. Past full lock
  // (the marker in big slides and spins) it carries on straight, so the marker still goes all
  // the way round.
  // The stretch follows speed, and the vehicle works it out (inp.k; its settings are
  // TUNE.STEER_* in vgsTelemetry.lua), because it smooths the marker on this same scale. The
  // values here are only the fallback for data without k (the README's images): k chosen so
  // the steering a 1 g corner needs (inp.sr) fills STEER_TARGET of the quarter, never below
  // STEER_EXPAND.
  var STEER_EXPAND = 20, STEER_TARGET = 0.6, STEER_K_MAX = 400;
  function asinhNorm(x, k) {
    return Math.log(k * x + Math.sqrt(k * k * x * x + 1)) / Math.log(k + Math.sqrt(k * k + 1));
  }
  function steerK(ref) {
    var k0 = STEER_EXPAND;
    if (!(STEER_TARGET > 0) || !(ref > 0) || ref >= 1) return k0;
    if (k0 > 0 && asinhNorm(ref, k0) >= STEER_TARGET) return k0;
    var lo = Math.log(Math.max(k0, 1)), hi = Math.log(STEER_K_MAX);
    if (asinhNorm(ref, STEER_K_MAX) <= STEER_TARGET) return STEER_K_MAX;
    for (var it = 0; it < 30; it++) {   // asinhNorm grows with k: bisect on log k
      var mid = (lo + hi) / 2;
      if (asinhNorm(ref, Math.exp(mid)) < STEER_TARGET) lo = mid; else hi = mid;
    }
    return Math.exp((lo + hi) / 2);
  }
  function steerScale(x, k) {
    if (k === undefined) k = STEER_EXPAND;
    var a = Math.abs(x);
    if (!(k > 0) || a >= 1) return x;
    return (x < 0 ? -1 : 1) * asinhNorm(a, k);
  }
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
    var sk = +inp.k > 0 ? +inp.k : steerK(+inp.sr);   // the vehicle sends the scale's stretch
    var steerShown = steerScale(steer, sk);
    if (steerShown > 0) arc(INPUT.steer, TOP - steerShown * Q, TOP);        // left: counter-clockwise from the top
    else if (steerShown < 0) arc(INPUT.steer, TOP, TOP - steerShown * Q);   // right: clockwise from the top
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
      var ang = TOP - steerScale(tv, sk) * Q, mh = markerSize(rPx), tip = rPx - lw - 0.5, base = tip - mh, half = mh * 0.5;
      var ux = Math.cos(ang), uy = Math.sin(ang), px = -uy, py = ux;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(cx + ux * tip, cy + uy * tip);
      ctx.lineTo(cx + ux * base + px * half, cy + uy * base + py * half);
      ctx.lineTo(cx + ux * base - px * half, cy + uy * base - py * half);
      ctx.closePath();
      ctx.fillStyle = travelColour(inp.bal, inp.dc);
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
    var broken = !!+wh.b, sliding = !!+wh.e, flat = !broken && !!+wh.fl;   // fl: flat or punctured tyre
    var airborne = !broken && !!+wh.a;   // off the ground: the whole inside light blue
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
        var fh = (sliding || airborne) ? ih : ih * grip;   // grows from the centre outward
        ctx.fillStyle = airborne ? STYLE.airborne : (sliding ? slideColour(wh.ex) : STYLE.gripFill);
        ctx.fillRect(-iw / 2, -fh / 2, iw, fh);
      }
    }

    ctx.lineWidth = lw;
    ctx.strokeStyle = broken ? STYLE.broken : torqueColour(wh.t);
    if (broken) ctx.setLineDash([3, 3]);
    else if (flat) ctx.setLineDash([Math.max(2, h * 0.12), Math.max(1.5, h * 0.08)]);   // flat: dashed, still showing grip and torque
    ctx.strokeRect(-w / 2 + lw / 2, -h / 2 + lw / 2, w - lw, h - lw);
    ctx.restore();

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

  // ===== Numbers mode ======================================================
  // Click the app to switch it on. Beside every corner: grip in use, slip angle and slip ratio,
  // and the load on it. Next to the circle (when the app is wide or tall enough): a panel with
  // the whole vehicle's numbers and how they compare: front against rear, left against right.

  // Units follow BeamNG's own unit settings, like its other apps.
  function Units() { this.length = 'metric'; this.temp = 'c'; this.pressure = 'bar'; this.weight = 'kg'; }
  Units.prototype.set = function (v) {
    if (!v) return;
    if (v.uiUnitLength) this.length = v.uiUnitLength;
    if (v.uiUnitTemperature) this.temp = v.uiUnitTemperature;
    if (v.uiUnitPressure) this.pressure = v.uiUnitPressure;
    if (v.uiUnitWeight) this.weight = v.uiUnitWeight;
  };
  Units.prototype.speed = function (ms) {
    return this.length === 'imperial' ? { v: ms * 2.23693629, u: 'mph' } : { v: ms * 3.6, u: 'km/h' };
  };
  Units.prototype.temperature = function (c) {
    if (this.temp === 'f') return { v: c * 1.8 + 32, u: '°F' };
    if (this.temp === 'k') return { v: c + 273.15, u: 'K' };
    return { v: c, u: '°C' };
  };
  Units.prototype.pressureOf = function (kpa) {
    switch (this.pressure) {
      case 'psi':  return { v: kpa * 0.145038, u: 'psi', d: 1 };
      case 'kPa':  return { v: kpa, u: 'kPa', d: 0 };
      case 'inHg': return { v: kpa * 0.2953, u: 'inHg', d: 1 };
      default:     return { v: kpa * 0.01, u: 'bar', d: 2 };
    }
  };
  Units.prototype.load = function (newtons) {
    var kg = newtons / 9.81;
    return this.weight === 'lb' ? { v: kg * 2.20462262, u: 'lb' } : { v: kg, u: 'kg' };
  };
  var DEFAULT_UNITS = new Units();

  // Text that changes every frame can't be read, so numbers are averaged over a short window
  // and refreshed a few times a second; bars use a light running average so they still move
  // smoothly. The drawing itself shows every update as it arrives.
  var READ_MS = 150, BAR_TAU_MS = 90;
  function Readouts() { this.acc = {}; this.val = {}; this.ema = {}; this.t0 = 0; }
  Readouts.prototype.add = function (key, v, now) {
    if (v === undefined || v === null || !isFinite(v)) return;
    v = +v;
    var a = this.acc[key] || (this.acc[key] = { s: 0, n: 0 });
    a.s += v; a.n++;
    if (!(key in this.val)) this.val[key] = v;   // the first value at once
    var e = this.ema[key];
    if (!e) this.ema[key] = { v: v, t: now };
    else { e.v += (v - e.v) * (1 - Math.exp(-Math.max(0, now - e.t) / BAR_TAU_MS)); e.t = now; }
  };
  Readouts.prototype.tick = function (now) {
    if (now - this.t0 < READ_MS) return;
    this.t0 = now;
    for (var k in this.acc) {
      var a = this.acc[k];
      if (a.n) { this.val[k] = a.s / a.n; a.s = 0; a.n = 0; }
      else { delete this.val[k]; delete this.ema[k]; delete this.acc[k]; }   // gone (numbers mode off, wheel lost)
    }
  };
  Readouts.prototype.get = function (key, fallback) { return key in this.val ? this.val[key] : fallback; };
  Readouts.prototype.smooth = function (key, fallback) { var e = this.ema[key]; return e ? e.v : fallback; };
  Readouts.prototype.clear = function () { this.acc = {}; this.val = {}; this.ema = {}; };

  var PANEL = {
    label: 'rgba(255, 255, 255, 0.5)', text: 'rgba(255, 255, 255, 0.92)', dim: 'rgba(255, 255, 255, 0.36)',
    rule: 'rgba(255, 255, 255, 0.08)', track: 'rgba(255, 255, 255, 0.09)', tick: 'rgba(255, 255, 255, 0.8)',
    load: ['rgba(150, 170, 200, 0.75)', 'rgba(110, 125, 150, 0.6)'],
    drive: ['rgba(70, 200, 95, 0.8)', 'rgba(50, 140, 70, 0.65)'],
    brake: ['rgba(235, 75, 65, 0.8)', 'rgba(160, 50, 45, 0.65)'],
    grip: 'rgba(236, 240, 246, 0.85)',
    hot: 'rgb(255, 150, 60)', vhot: 'rgb(255, 80, 70)', cold: 'rgb(140, 190, 255)'
  };
  var FONT = '"Noto Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
  function font(px, weight) { return (weight || 400) + ' ' + px.toFixed(1) + 'px ' + FONT; }
  function fmt(v, d) {
    if (v === undefined || v === null || !isFinite(v)) return '–';
    var s = (+v).toFixed(d || 0);
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);   // no "-0"
    return s.replace('-', '−');
  }
  function degOf(rad) { return rad === undefined || rad === null ? undefined : rad * 180 / Math.PI; }
  function text(ctx, s, x, y, px, weight, colour, align) {
    ctx.font = font(px, weight); ctx.fillStyle = colour;
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
    return ctx.measureText(s).width;
  }
  function measure(ctx, s, px, weight) { ctx.font = font(px, weight); return ctx.measureText(s).width; }

  // Front/rear and left/right comparisons for one body, from its wheels (numbers mode values).
  function computeSplits(m) {
    var ws = toArray(m.wheels).filter(function (w) { return !+w.b; });
    if (ws.length < 2) return null;
    var minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    ws.forEach(function (w) {
      minY = Math.min(minY, +w.y); maxY = Math.max(maxY, +w.y);
      minX = Math.min(minX, +w.x); maxX = Math.max(maxX, +w.x);
    });
    var hasFR = maxY - minY > 0.5, hasLR = maxX - minX > 0.3;
    var midY = (minY + maxY) / 2, midX = (minX + maxX) / 2;
    var a = { fzF: 0, fzR: 0, fzL: 0, fzRt: 0, yF: 0, nF: 0, yR: 0, nR: 0, xL: 0, nL: 0, xRt: 0, nRt: 0,
              gF: 0, gR: 0, dF: 0, dR: 0, dL: 0, dRt: 0, bF: 0, bR: 0, drvF: 0, drvR: 0, drvL: 0, drvRt: 0, haveFz: false };
    ws.forEach(function (w) {
      var front = +w.y > midY, left = +w.x < midX, fz = +w.fz, drive = Math.max(0, +w.dq || 0), brake = Math.abs(+w.bq || 0);
      if (isFinite(fz) && w.fz !== undefined) a.haveFz = true; else fz = 0;
      if (front) { a.fzF += fz; a.yF += +w.y; a.nF++; a.gF += +w.g || 0; a.dF += drive; a.bF += brake; if (+w.d) a.drvF++; if (+w.e) a.sF = true; }
      else { a.fzR += fz; a.yR += +w.y; a.nR++; a.gR += +w.g || 0; a.dR += drive; a.bR += brake; if (+w.d) a.drvR++; if (+w.e) a.sR = true; }
      if (left) { a.fzL += fz; a.xL += +w.x; a.nL++; a.dL += drive; if (+w.d) a.drvL++; }
      else { a.fzRt += fz; a.xRt += +w.x; a.nRt++; a.dRt += drive; if (+w.d) a.drvRt++; }
    });
    var r = {};
    function share(p, q) { return p + q > 1e-6 ? p / (p + q) : undefined; }
    if (hasFR && a.nF && a.nR) {
      if (a.haveFz) r.loadF = share(a.fzF, a.fzR);
      r.gripF = a.gF / a.nF; r.gripR = a.gR / a.nR; r.slideF = a.sF ? 1 : 0; r.slideR = a.sR ? 1 : 0;
      if (a.drvF && a.drvR && a.dF + a.dR > 20) r.driveF = share(a.dF, a.dR);
      if (a.bF + a.bR > 50) r.brakeF = share(a.bF, a.bR);
      var yF = a.yF / a.nF, yR = a.yR / a.nR;
      if (m.cg && yF - yR > 0.3) r.statF = clamp((+m.cg.y - yR) / (yF - yR), 0, 1);
    }
    if (hasLR && a.nL && a.nRt) {
      if (a.haveFz) r.loadL = share(a.fzL, a.fzRt);
      if (a.drvL && a.drvRt && a.dL + a.dRt > 20) r.driveL = share(a.dL, a.dRt);
      var xL = a.xL / a.nL, xR = a.xRt / a.nRt;
      if (m.cg && xR - xL > 0.3) r.statL = clamp((xR - +m.cg.x) / (xR - xL), 0, 1);
    }
    return r;
  }

  // Readouts beside each corner: grip in use; slip angle (alpha) and slip ratio (kappa); load.
  // A dual set shows its hardest-working tyre and the load on the whole set.
  function drawCornerReadouts(ctx, p, dims, circle, opts) {
    var body = p.body, R = opts.read, U = opts.units || DEFAULT_UNITS, done = {};
    function rd(w, f) {
      var raw = w[f];
      if (raw === undefined || raw === null) return undefined;
      return R ? R.get(body.id + ':w' + w.i + '.' + f, +raw) : +raw;
    }
    function maxAbs(list, f) {
      var best;
      list.forEach(function (w) { var v = rd(w, f); if (v !== undefined && (best === undefined || Math.abs(v) > Math.abs(best))) best = v; });
      return best;
    }
    body.wheels.forEach(function (wh) {
      if (wh._outer === false) return;
      var set = wh._set ? wh._set.wheels : [wh], seen = {}, list = [];
      set.forEach(function (w) { if (!seen[w.i]) { seen[w.i] = true; list.push(w); } });
      var key = list.map(function (w) { return w.i; }).join(',');
      if (done[key]) return;
      done[key] = true;
      var grip = maxAbs(list, 'g') || 0, sliding = list.some(function (w) { return !!+w.e; });
      var broken = list.every(function (w) { return !!+w.b; });
      var sa = maxAbs(list, 'sa'), sr = maxAbs(list, 'sr'), load;
      list.forEach(function (w) { var f = rd(w, 'fz'); if (f !== undefined) load = (load || 0) + f; });
      var pt = p.wheelPoint(wh), d = dims(wh), onLeft = !!(wh._set && wh._set.side < 0);
      var fs = clamp(d.h * 0.26, 8, 12), small = fs * 0.82;
      var lines = [];
      if (broken) lines.push({ s: 'broken', px: small, w: 600, c: PANEL.dim });
      else {
        lines.push({ s: Math.round(grip * 100) + '%', px: fs, w: 600, c: sliding ? slideColour(Math.max.apply(null, list.map(function (w) { return +w.ex || 0; }))) : STYLE.text });
        if (sa !== undefined || sr !== undefined) {
          lines.push({ s: 'α ' + fmt(degOf(sa), 1) + '°  κ ' + fmt(sr === undefined ? undefined : sr * 100, 0) + '%', px: small, w: 400, c: STYLE.text });
        } else if (list[0].sl !== undefined) {
          lines.push({ s: fmt(maxAbs(list, 'sl'), 1) + ' m/s', px: small, w: 400, c: STYLE.text });
        }
        if (load !== undefined) { var lu = U.load(load); lines.push({ s: fmt(lu.v, 0) + ' ' + lu.u, px: small, w: 400, c: PANEL.label }); }
      }
      var widest = 0, height = 0;
      lines.forEach(function (l) { l.width = measure(ctx, l.s, l.px, l.w); widest = Math.max(widest, l.width); height += l.px * 1.18; });
      var r = dotRadius(d.w);
      var clear = d.w / 2 + Math.abs(Math.sin(+wh.s || 0)) * d.h / 2 + Math.max(3, r) + 2 * r + 4;
      var tx = onLeft ? pt.x - clear : pt.x + clear, align = onLeft ? 'right' : 'left';
      // keep the block inside the circle; if that would put it over the tyre, put it on the
      // tyre's inner side instead
      var y0 = pt.y - height / 2, worst = Math.max(Math.abs(y0 - circle.cy), Math.abs(y0 + height - circle.cy));
      var half = Math.sqrt(Math.max(0, circle.r * circle.r - worst * worst)) - 3;
      var reachX = d.w / 2 + Math.abs(Math.sin(+wh.s || 0)) * d.h / 2 + 2;
      if (onLeft) {
        tx = Math.max(tx, circle.cx - half + widest);
        if (tx > pt.x - reachX) { tx = pt.x + reachX + 2; align = 'left'; }
      } else {
        tx = Math.min(tx, circle.cx + half - widest);
        if (tx < pt.x + reachX) { tx = pt.x - reachX - 2; align = 'right'; }
      }
      var y = y0;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'; ctx.shadowBlur = 3;
      lines.forEach(function (l) {
        y += l.px * 1.18;
        text(ctx, l.s, tx, y - l.px * 0.22, l.px, l.w, l.c, align);
      });
      ctx.restore();
    });
  }

  // The panel: rows of the lead vehicle's numbers, fitted to the space by dropping the least
  // important rows first when it's small.
  function panelRows(ctx, m, opts) {
    var vd = m.vd || {}, U = opts.units || DEFAULT_UNITS, R = opts.read, id = m.id, inp = m.inp || {};
    var sp = opts.splits || computeSplits(m) || {};
    function rv(key, raw) { if (raw === undefined || raw === null) return undefined; return R ? R.get(id + ':' + key, +raw) : +raw; }
    function sm(key, raw) { if (raw === undefined || raw === null) return undefined; return R ? R.smooth(id + ':' + key, +raw) : +raw; }
    var rows = [];
    function row(h, pri, draw, action) { rows.push({ h: h, pri: pri, draw: draw, action: action }); }

    // speed, gear, rpm
    row(2.25, 0, function (x, y, w, f) {
      var sp2 = U.speed(rv('vd.v', vd.v) || 0);
      var nw = text(ctx, vd.v === undefined ? '–' : fmt(sp2.v, 0), x, y + 1.75 * f, 1.95 * f, 600, PANEL.text);
      text(ctx, sp2.u, x + nw + 0.35 * f, y + 1.75 * f, 0.78 * f, 400, PANEL.label);
      var gw = text(ctx, vd.gear !== undefined ? String(vd.gear) : '', x + w, y + 1.75 * f, 1.95 * f, 600, PANEL.text, 'right');
      if (vd.rpm !== undefined) text(ctx, fmt(rv('vd.rpm', vd.rpm), 0) + ' rpm', x + w - gw - 0.5 * f, y + 1.75 * f, 0.78 * f, 400, PANEL.label, 'right');
    });

    // understeer / oversteer
    row(2.75, 1, function (x, y, w, f) {
      var af = rv('vd.af', vd.af), ar = rv('vd.ar', vd.ar), bal = inp.bal;
      var diff = (af !== undefined && ar !== undefined) ? degOf(af - ar) : undefined;   // + = front slipping more
      var status = '–', colour = PANEL.dim;
      if (bal !== undefined && bal !== null) {
        colour = travelColour(bal, inp.dc);
        if (bal <= -UNDER_WARN) status = 'Understeer';
        else if (bal < -0.04) status = 'Front near limit';
        else if (bal >= 0.15) status = (+inp.dc >= 0.6) ? 'Drifting, in control' : 'Oversteer';
        else { status = 'Neutral'; colour = PANEL.text; }
      }
      text(ctx, 'BALANCE', x, y + 0.85 * f, 0.72 * f, 600, PANEL.label);
      text(ctx, status + (diff !== undefined && status !== 'Neutral' && status !== '–' ? '  ' + fmt(Math.abs(diff), 1) + '°' : ''), x + w, y + 0.85 * f, 0.9 * f, 600, colour, 'right');
      // bar: understeer to the left, oversteer to the right, +-8 deg of difference
      var by = y + 1.45 * f, bh = Math.max(3, 0.32 * f), cx = x + w / 2;
      ctx.fillStyle = PANEL.track; ctx.fillRect(x, by - bh / 2, w, bh);
      var dv = sm('vd.bal', diff);
      if (dv !== undefined) {
        var len = clamp(dv / 8, -1, 1) * w / 2;
        ctx.fillStyle = bal !== undefined ? travelColour(bal, inp.dc) : PANEL.grip;
        ctx.fillRect(len > 0 ? cx - len : cx, by - bh / 2, Math.abs(len), bh);
      }
      ctx.fillStyle = PANEL.tick; ctx.fillRect(cx - 0.5, by - bh, 1, bh * 2);
      text(ctx, 'US', x, by + 1.0 * f, 0.62 * f, 600, PANEL.dim);
      text(ctx, 'OS', x + w, by + 1.0 * f, 0.62 * f, 600, PANEL.dim, 'right');
      text(ctx, 'front α ' + fmt(degOf(af), 1) + '°   rear α ' + fmt(degOf(ar), 1) + '°', cx, by + 1.0 * f, 0.7 * f, 400, PANEL.label, 'center');
    });

    // G-force now
    row(1.45, 2, function (x, y, w, f) {
      var gx = Math.abs(+((m.gf || {}).x) || 0), gy = +((m.gf || {}).y) || 0;
      gx = rv('gf.x', gx); gy = rv('gf.y', gy);
      var cols = [
        ['LAT', fmt(gx, 2)],
        [gy >= 0 ? 'BRAKE' : 'ACCEL', fmt(Math.abs(gy), 2)],
        ['TOTAL', fmt(Math.hypot(gx || 0, gy || 0), 2)]
      ];
      text(ctx, 'G', x, y + 1.05 * f, 0.72 * f, 600, PANEL.label);
      var cw = (w - 1.6 * f) / 3;
      cols.forEach(function (c, k) {
        var cx2 = x + 1.6 * f + cw * k;
        var lw = text(ctx, c[0], cx2, y + 1.05 * f, 0.62 * f, 600, PANEL.dim);
        text(ctx, c[1], cx2 + lw + 0.3 * f, y + 1.05 * f, 0.95 * f, 600, PANEL.text);
      });
    });

    // assists fitted and acting
    if (vd.asf) {
      row(1.55, 2.5, function (x, y, w, f) {
        var names = [['ABS', 1, ASSIST[1].colour], ['TCS', 2, ASSIST[2].colour], ['ESC', 4, ASSIST[3].colour]];
        var cx2 = x, ch = 1.1 * f;
        names.forEach(function (n) {
          if (!(vd.asf & n[1])) return;
          var on = !!(vd.asa & n[1]), tw = measure(ctx, n[0], 0.68 * f, 700), cw = tw + 1.0 * f;
          roundRect(ctx, cx2, y + 0.2 * f, cw, ch, ch / 2);
          if (on) { ctx.fillStyle = n[2]; ctx.fill(); }
          ctx.strokeStyle = on ? n[2] : PANEL.dim; ctx.lineWidth = 1; ctx.stroke();
          text(ctx, n[0], cx2 + cw / 2, y + 0.2 * f + ch * 0.72, 0.68 * f, 700, on ? 'rgb(12, 14, 18)' : PANEL.label, 'center');
          cx2 += cw + 0.45 * f;
        });
        if (vd.tf !== undefined && vd.tf < 0.995) {
          text(ctx, 'power −' + fmt((1 - vd.tf) * 100, 0) + '%', x + w, y + 0.2 * f + ch * 0.72, 0.75 * f, 600, ASSIST[2].colour, 'right');
        }
      });
    }

    // steering and turning
    row(1.45, 3, function (x, y, w, f) {
      var yaw = rv('vd.yr', vd.yr);
      var cols = [
        ['WHEELS', fmt(degOf(rv('vd.fw', vd.fw)), 1) + '°'],
        ['TURNING', fmt(degOf(rv('vd.turn', vd.turn)), 1) + '°'],
        ['YAW', fmt(degOf(yaw), 0) + '°/s']
      ];
      var cw = w / 3;
      cols.forEach(function (c, k) {
        var cx2 = x + cw * k;
        var lw = text(ctx, c[0], cx2, y + 1.05 * f, 0.62 * f, 600, PANEL.dim);
        text(ctx, c[1], cx2 + lw + 0.3 * f, y + 1.05 * f, 0.92 * f, 600, PANEL.text);
      });
    });

    // drift angle: the body's slip angle, how far it's travelling sideways
    row(1.45, 4, function (x, y, w, f) {
      var b = degOf(rv('vd.beta', vd.beta));
      var big = b !== undefined && Math.abs(b) >= 3;
      text(ctx, 'DRIFT ANGLE', x, y + 1.05 * f, 0.62 * f, 600, PANEL.dim);
      text(ctx, b === undefined ? '–' : fmt(Math.abs(b), 0) + '°', x + w, y + 1.05 * f, (big ? 1.1 : 0.92) * f, 600, big ? TRAVEL_COLOUR_CSS.over : PANEL.text, 'right');
      if (big) {   // a thin gauge: the slide, up to 60 deg
        var gw = w * 0.42, gx2 = x + w * 0.33, by = y + 0.72 * f;
        ctx.fillStyle = PANEL.track; ctx.fillRect(gx2, by, gw, Math.max(2, 0.22 * f));
        ctx.fillStyle = TRAVEL_COLOUR_CSS.over; ctx.fillRect(gx2, by, gw * clamp(Math.abs(b) / 60, 0, 1), Math.max(2, 0.22 * f));
      }
    });

    // front/rear and left/right splits
    function split(label, key, value, ref, colours, ends) {
      return function (x, y, w, f) {
        var lw = 5.2 * f, bx = x + lw, bw = w - lw, by = y + 0.35 * f, bh = 0.95 * f;
        text(ctx, label, x, y + 1.05 * f, 0.62 * f, 600, PANEL.dim);
        var v = sm('sp.' + key, value), num = rv('sp.' + key, value);
        if (v === undefined) {
          ctx.fillStyle = PANEL.track; ctx.fillRect(bx, by, bw, bh);
          text(ctx, '–', bx + bw / 2, by + bh * 0.78, 0.72 * f, 600, PANEL.dim, 'center');
          return;
        }
        v = clamp(v, 0, 1);
        ctx.fillStyle = colours[0]; ctx.fillRect(bx, by, bw * v, bh);
        ctx.fillStyle = colours[1]; ctx.fillRect(bx + bw * v, by, bw * (1 - v), bh);
        if (ref !== undefined) {   // the vehicle standing still, for comparison
          var rx = bx + bw * clamp(ref, 0, 1);
          ctx.fillStyle = PANEL.tick; ctx.fillRect(rx - 0.75, by - 0.2 * f, 1.5, bh + 0.4 * f);
        }
        text(ctx, ends[0] + ' ' + fmt(num * 100, 0), bx + 0.3 * f, by + bh * 0.78, 0.7 * f, 700, 'rgba(10, 12, 16, 0.9)');
        text(ctx, fmt((1 - num) * 100, 0) + ' ' + ends[1], bx + bw - 0.3 * f, by + bh * 0.78, 0.7 * f, 700, 'rgba(255, 255, 255, 0.9)', 'right');
      };
    }
    row(1.55, 5, split('LOAD F/R', 'loadF', sp.loadF, sp.statF, PANEL.load, ['F', 'R']));
    row(1.55, 5.5, split('LOAD L/R', 'loadL', sp.loadL, sp.statL, PANEL.load, ['L', 'R']));
    var drivenF = toArray(m.wheels).some(function (w) { return +w.d && +w.y > 0; });
    var drivenR = toArray(m.wheels).some(function (w) { return +w.d && +w.y <= 0; });
    if (drivenF && drivenR) row(1.55, 6, split('DRIVE F/R', 'driveF', sp.driveF, undefined, PANEL.drive, ['F', 'R']));
    if (toArray(m.wheels).some(function (w) { return +w.d; })) row(1.55, 6.2, split('DRIVE L/R', 'driveL', sp.driveL, undefined, PANEL.drive, ['L', 'R']));
    row(1.55, 6.4, split('BRAKE F/R', 'brakeF', sp.brakeF, undefined, PANEL.brake, ['F', 'R']));
    // grip in use, front and rear axle averages
    row(1.55, 6.6, function (x, y, w, f) {
      var lw = 5.2 * f, half = (w - lw - 0.6 * f) / 2, by = y + 0.35 * f, bh = 0.95 * f;
      text(ctx, 'GRIP', x, y + 1.05 * f, 0.62 * f, 600, PANEL.dim);
      [['F', 'gripF'], ['R', 'gripR']].forEach(function (g, k) {
        var bx = x + lw + k * (half + 0.6 * f), v = sm('sp.' + g[1], sp[g[1]]), num = rv('sp.' + g[1], sp[g[1]]);
        ctx.fillStyle = PANEL.track; ctx.fillRect(bx, by, half, bh);
        // past 100 %: pink, as a tyre just over its limit; red once a tyre on that axle slides
        var sliding = sp[g[1] === 'gripF' ? 'slideF' : 'slideR'];
        if (v !== undefined) { ctx.fillStyle = sliding ? slideColour(0.6) : (v > 1 ? slideColour(0) : PANEL.grip); ctx.fillRect(bx, by, half * clamp(v, 0, 1), bh); }
        var dark = v !== undefined && v > 0.45;
        text(ctx, g[0] + ' ' + (num === undefined ? '–' : fmt(num * 100, 0) + '%'), bx + 0.3 * f, by + bh * 0.78, 0.7 * f, 700, dark ? 'rgba(10, 12, 16, 0.9)' : PANEL.text);
      });
    });

    // tyre temperatures and pressures, brake temperatures: one line per axle, left | right
    var axles = findAxles(toArray(m.wheels).filter(function (w) { return !+w.b; }));
    function perAxle(fieldList) {
      return axles.slice(0, 4).map(function (a) {
        var left = a.wheels.filter(function (w) { return +w.x < a.cx - 0.01; }), right = a.wheels.filter(function (w) { return +w.x > a.cx + 0.01; });
        if (!left.length && !right.length) left = a.wheels;
        function pick(ws, f) {   // the hottest / highest of a dual set
          var best;
          ws.forEach(function (w) { var v = w[f]; if (v !== undefined && v !== null) { v = rv('w' + w.i + '.' + f, v); if (best === undefined || v > best) best = v; } });
          return best;
        }
        return { L: fieldList.map(function (f) { return pick(left, f); }), R: fieldList.map(function (f) { return pick(right, f); }) };
      });
    }
    function tempColour(c, warm, hot, cold) {
      if (c === undefined) return PANEL.dim;
      if (c >= hot) return PANEL.vhot;
      if (c >= warm) return PANEL.hot;
      if (cold !== undefined && c < cold) return PANEL.cold;
      return PANEL.text;
    }
    var hasTyre = toArray(m.wheels).some(function (w) { return w.tt !== undefined || w.tp !== undefined; });
    if (hasTyre && axles.length) {
      var tyreRows = perAxle(['tt', 'tp']);
      var pu = U.pressureOf(0).u, tu = U.temperature(0).u;
      row(1.2 + 1.2 * tyreRows.length, 8, function (x, y, w, f) {
        text(ctx, 'TYRES', x, y + 0.9 * f, 0.62 * f, 600, PANEL.dim);
        text(ctx, tu + '  ·  ' + pu, x + w, y + 0.9 * f, 0.62 * f, 600, PANEL.dim, 'right');
        tyreRows.forEach(function (r, k) {
          var yy = y + (2.0 + 1.2 * k) * f;
          [['L', x + w * 0.02, 'left'], ['R', x + w * 0.98, 'right']].forEach(function (side) {
            var vals = r[side[0]], t = vals[0], pr = vals[1];
            var ts = t === undefined ? '–' : fmt(U.temperature(t).v, 0) + '°';
            var pv = pr === undefined ? undefined : U.pressureOf(pr);
            var ps = pv ? fmt(pv.v, pv.d) : '–';
            var s1 = side[0] === 'L' ? ts : ps, s2 = side[0] === 'L' ? ps : ts;
            var c1 = side[0] === 'L' ? tempColour(t, 110, 130, 40) : PANEL.text, c2 = side[0] === 'L' ? PANEL.text : tempColour(t, 110, 130, 40);
            var w1 = text(ctx, s1, side[1], yy, 0.88 * f, 600, c1, side[2]);
            text(ctx, s2, side[2] === 'left' ? side[1] + w1 + 0.7 * f : side[1] - w1 - 0.7 * f, yy, 0.88 * f, 400, c2, side[2]);
          });
          text(ctx, axleName(k, tyreRows.length), x + w / 2, yy, 0.62 * f, 600, PANEL.dim, 'center');
        });
      });
    }
    var hasBrake = toArray(m.wheels).some(function (w) { return w.bt !== undefined; });
    if (hasBrake && axles.length) {
      var brakeRows = perAxle(['bt']);
      row(1.2 + 1.2 * brakeRows.length, 9, function (x, y, w, f) {
        text(ctx, 'BRAKES', x, y + 0.9 * f, 0.62 * f, 600, PANEL.dim);
        text(ctx, U.temperature(0).u, x + w, y + 0.9 * f, 0.62 * f, 600, PANEL.dim, 'right');
        brakeRows.forEach(function (r, k) {
          var yy = y + (2.0 + 1.2 * k) * f;
          var l = r.L[0], rr = r.R[0];
          text(ctx, l === undefined ? '–' : fmt(U.temperature(l).v, 0) + '°', x + w * 0.02, yy, 0.88 * f, 600, tempColour(l, 400, 650), 'left');
          text(ctx, rr === undefined ? '–' : fmt(U.temperature(rr).v, 0) + '°', x + w * 0.98, yy, 0.88 * f, 600, tempColour(rr, 400, 650), 'right');
          text(ctx, axleName(k, brakeRows.length), x + w / 2, yy, 0.62 * f, 600, PANEL.dim, 'center');
        });
      });
    }

    // peaks since the vehicle was reset (click the row to clear them)
    var pk = opts.peaks || {};
    row(1.3, 7, function (x, y, w, f) {
      text(ctx, 'PEAK G', x, y + 0.95 * f, 0.62 * f, 600, PANEL.dim);
      var s = 'lat ' + fmt(pk.lat, 2) + '   brake ' + fmt(pk.brk, 2) + '   accel ' + fmt(pk.acc, 2);
      text(ctx, s, x + w - 1.4 * f, y + 0.95 * f, 0.72 * f, 600, PANEL.label, 'right');
      text(ctx, '↺', x + w, y + 0.98 * f, 0.9 * f, 600, PANEL.dim, 'right');
    }, 'resetPeaks');
    return rows;
  }
  function axleName(k, n) { return n <= 1 ? '' : (k === 0 ? 'FRONT' : (n === 2 ? 'REAR' : 'AXLE ' + (k + 1))); }
  var TRAVEL_COLOUR_CSS = { over: 'rgb(235, 70, 205)' };

  // Lay the rows out in the panel (one or two columns), largest text that fits, dropping the
  // least important rows when even small text doesn't.
  var PANEL_MIN_FONT = 8.5, PANEL_MAX_FONT = 14, PANEL_CHARS = 17;   // a row needs about 17 font sizes of width
  function drawPanel(ctx, rect, m, opts, hits) {
    var rows = panelRows(ctx, m, opts);
    var pad = 8, gap = 0.4;
    function fit(list, cols) {
      var colW = (rect.w - pad * 2 - (cols - 1) * pad) / cols;
      var total = list.reduce(function (s, r) { return s + r.h + gap; }, 0) - gap;
      var perCol = total / cols + (cols > 1 ? 2.5 : 0);   // a little slack for uneven columns
      return Math.min((rect.h - pad * 2) / perCol, colW / PANEL_CHARS, PANEL_MAX_FONT);
    }
    var list = rows.slice(), cols = 1, f = fit(list, 1);
    if (f < 11 && rect.w > rect.h * 1.3) { var f2 = fit(list, 2); if (f2 > f) { f = f2; cols = 2; } }
    while (f < PANEL_MIN_FONT && list.length > 1) {   // drop the least important row
      var worst = list.reduce(function (a, r) { return r.pri > a.pri ? r : a; }, list[0]);
      list.splice(list.indexOf(worst), 1);
      f = fit(list, cols);
      if (cols === 1 && rect.w > rect.h * 1.3) { var f3 = fit(list, 2); if (f3 > f) { f = f3; cols = 2; } }
    }
    if (f < 6) return;
    // background, the same as the circle's
    roundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, Math.min(10, rect.w * 0.05));
    ctx.fillStyle = STYLE.panelFill; ctx.fill();
    ctx.strokeStyle = STYLE.panelStroke; ctx.lineWidth = 1; ctx.stroke();
    var colW = (rect.w - pad * 2 - (cols - 1) * pad) / cols;
    var total = list.reduce(function (s, r) { return s + r.h + gap; }, 0) - gap, target = total / cols;
    var col = 0, y = rect.y + pad, used = 0;
    // spread leftover height evenly between rows of the column
    var spare = cols === 1 ? Math.max(0, (rect.h - pad * 2) / f - total) : 0, extra = list.length > 1 ? Math.min(spare / (list.length - 1), 0.9) : 0;
    ctx.save();
    list.forEach(function (r, k) {
      if (cols > 1 && col < cols - 1 && used > 0 && used + r.h / 2 > target) { col++; y = rect.y + pad; used = 0; }
      var x = rect.x + pad + col * (colW + pad);
      if (used > 0) {   // a faint rule between rows
        ctx.fillStyle = PANEL.rule; ctx.fillRect(x, y - (gap + extra) * f / 2, colW, 1);
      }
      r.draw(x, y, colW, f);
      if (r.action && hits) hits.push({ x: x, y: y, w: colW, h: r.h * f, action: r.action });
      y += (r.h + gap + extra) * f; used += r.h + gap;
    });
    ctx.restore();
  }

  // Where the circle and the panel go. Without the panel, the circle fills the app. With it, the
  // panel takes the space beside the circle along the app's longer side (at least
  // PANEL_SHARE of it); in a small app there's no panel, only the readouts by the wheels.
  var PANEL_SHARE = 0.4;
  function layoutRegions(W, H, withPanel) {
    var full = { cx: W / 2, cy: H / 2, r: Math.max(4, Math.min(W, H) / 2 - 2), panel: null };
    if (!withPanel) return full;
    var landscape = W >= H, long = landscape ? W : H, short = landscape ? H : W;
    var d = Math.min(short, long * (1 - PANEL_SHARE)), gap = 6;
    if (long - d - gap < 130 || short < 150) return full;
    if (landscape) return { cx: d / 2, cy: H / 2, r: d / 2 - 2, panel: { x: d + gap, y: 0, w: W - d - gap, h: H } };
    return { cx: W / 2, cy: d / 2, r: d / 2 - 2, panel: { x: 0, y: d + gap, w: W, h: H - d - gap } };
  }

  // ===== Renderer ==========================================================
  function prepareBodies(data) {
    return toArray(data && data.bodies)
      .map(function (b) {
        var wheels = [];
        toArray(b.wheels).forEach(function (w, k) {
          if (w.i === undefined) w.i = k;   // older payloads without ids
          // a wheel standing in for a dual pair (w.nt = 2) is drawn as that many tyres;
          // they share its data and are laid out side by side like any dual set
          var n = clamp(Math.round(+w.nt || 1), 1, 4);
          for (var c = 0; c < n; c++) wheels.push(c === 0 ? w : Object.assign({}, w));
        });
        return { id: b.id, wheels: wheels, sources: toArray(b.sources), inp: b.inp, gf: b.gf, ext: b.ext, dt: b.dt, vd: b.vd, cg: b.cg, m: b.m };
      })
      .filter(function (b) { return b.wheels.length > 0; });
  }

  // draw(data, opts): data = { bodies: [...] } (lead vehicle first); opts.numbers switches the
  // numbers mode on. Returns the clickable regions it drew ({ x, y, w, h, action }).
  VGSRenderer.prototype.draw = function (data, opts) {
    opts = opts || {};
    var size = this.fit(), ctx = this.ctx, W = size.w, H = size.h;
    var trail = this.gTrail, hits = [];
    this.hits = hits;
    ctx.clearRect(0, 0, W, H);
    var bodies = prepareBodies(data);
    if (!bodies.length) { trail.length = 0; this.leadId = undefined; drawEmpty(ctx, W, H); return hits; }
    // a different vehicle: no trail from the old one
    if (!bodies[0].gf || (this.leadId !== undefined && bodies[0].id !== this.leadId)) trail.length = 0;
    this.leadId = bodies[0].id;
    // every vehicle is laid out from its real footprint when the vehicle reports one
    bodies.forEach(function (b) { b.geo = bodyGeometry(b.wheels, b.sources, b.ext); });

    var region = layoutRegions(W, H, !!opts.numbers);
    var scale, placements = [];
    // The big circle is always the same size; vehicles are scaled to fit inside it, clear of
    // the input arcs on its rim.
    var rPx = region.r, ccx = region.cx, ccy = region.cy;
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

    // in numbers mode the vehicle is drawn a little smaller, to make room for the readouts
    var shrink = opts.numbers ? NUMBERS_SHRINK : 1;
    if (bodies.length === 1) {
      // centred on the vehicle's body, one scale for everything (true proportions)
      scale = inner / fitRadius(bodies[0]);
      if (opts.numbers) scale *= readoutShrink(ctx, bodies[0], scale, inner);
      if (bodies[0].geo.hasExt) outline(bodies[0], ccx, ccy);
      placements.push({ body: bodies[0], ox: ccx, oy: ccy });
    } else {
      // tractor + trailer, articulated sections: stacked front to back, one shared scale
      var maxHalfW = 0, totalH = BODY_GAP * (bodies.length - 1);
      bodies.forEach(function (b) { maxHalfW = Math.max(maxHalfW, b.geo.halfW); totalH += b.geo.halfH * 2; });
      scale = inner / Math.hypot(maxHalfW, totalH / 2) * shrink;
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
    // Pass 2: tyres and assist dots on top. Pass 3 (numbers mode): readouts and the panel.
    var dims = function (wh) {
      return { w: Math.max(wh._wd * scale, MIN_TYRE_W), h: Math.max(wh._len * scale, MIN_TYRE_L) };
    };
    placements.forEach(function (p) {
      var g = p.body.geo;
      var map = p.map = function (x, y) {   // vehicle metres -> canvas pixels, forward = up
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

    if (opts.numbers) {
      var circle = { cx: ccx, cy: ccy, r: inner };
      placements.forEach(function (p) { drawCornerReadouts(ctx, p, dims, circle, opts); });
      if (region.panel) drawPanel(ctx, region.panel, bodies[0], opts, hits);
    }
    return hits;
  };
  var NUMBERS_SHRINK = 0.86;   // stacked vehicles in numbers mode

  // How much smaller to draw a lone vehicle in numbers mode so every corner's readout fits
  // beside its tyre, inside the circle.
  function readoutShrink(ctx, body, scale, inner) {
    var g = body.geo, sample = '\u03b1 10.0\u00b0  \u03ba 10%';
    for (var k = 1; k >= 0.5; k -= 0.025) {
      var s2 = scale * k, ok = true;
      for (var i = 0; i < body.wheels.length && ok; i++) {
        var w = body.wheels[i];
        if (w._outer === false) continue;
        var tw = Math.max(w._wd * s2, MIN_TYRE_W), th = Math.max(w._len * s2, MIN_TYRE_L);
        var fs = clamp(th * 0.26, 8, 12), textW = measure(ctx, sample, fs * 0.82, 400), textH = fs * 1.18 * 3;
        var x = Math.abs(w._mx - g.cx) * s2 + tw / 2 + dotRadius(tw) * 3 + 7 + textW;
        var y = Math.abs(+w.y - g.cy) * s2 + textH / 2;
        if (x * x + y * y > (inner - 3) * (inner - 3)) ok = false;
      }
      if (ok) return k;
    }
    return 0.5;
  }

  // ===== Data from the game ================================================
  // Each displayed vehicle sends its own updates ('VGSData', straight from its Lua); the hub says
  // which vehicles make up the player's chain ('VGSChain'). The layout comes as a separate block
  // (st) when it changes and every couple of seconds; it's kept per vehicle and merged with the
  // live values into the shape the renderer draws.
  // layout fields a live update never overwrites (everything else it sends is copied as is)
  var STATIC_KEYS = { i: 1, n: 1, nt: 1, rd: 1, wd: 1, x: 1, y: 1 };
  var READ_WHEEL = ['g', 'sa', 'sr', 'fz', 'tt', 'tc', 'tp', 'bt', 'sl'];
  var READ_VD = ['v', 'yr', 'beta', 'fw', 'turn', 'af', 'ar', 'rpm'];
  var STALE_MS = 1500;   // a coupled body this far behind the lead vehicle's updates is dropped

  function VGSStore() {
    this.bodies = {};      // id -> { id, st, lv, d (latest update), t (ms), merged }
    this.chain = null;     // { p: player vehicle id (-1 = none), ch: [ids] }
    this.read = new Readouts();
    this.peaks = { lat: undefined, brk: undefined, acc: undefined };
    this.peakKey = null;
    this.layoutAsked = {}; // id -> ms of the last layout request
  }
  VGSStore.prototype.leadId = function () {
    if (this.chain && this.chain.p > 0) return this.chain.p;
    var best, bestT = -Infinity;
    for (var id in this.bodies) {
      var b = this.bodies[id];
      if (b.d && +b.d.pl) return +id;                    // the vehicle says the player is in it
      if (b.t > bestT) { bestT = b.t; best = +id; }
    }
    return best;   // before the hub has said: the vehicle heard from last
  };
  // Returns the id of a vehicle whose layout should be requested, or null.
  VGSStore.prototype.ingest = function (p, now) {
    if (!p || typeof p.id !== 'number') return null;
    var b = this.bodies[p.id] || (this.bodies[p.id] = { id: p.id });
    if (p.st) { b.st = p.st; b.lv = p.lv; b.merged = null; }
    b.d = p; b.t = now;
    var ask = null;
    if (!b.st || b.lv !== p.lv) {   // updates without (the current) layout: ask, at most once a second
      if (!this.layoutAsked[p.id] || now - this.layoutAsked[p.id] > 1000) { this.layoutAsked[p.id] = now; ask = p.id; }
      return ask;
    }
    var m = mergeBody(b), R = this.read, id = p.id;
    if (p.vd) {   // numbers mode: feed the readouts
      toArray(m.wheels).forEach(function (w) {
        READ_WHEEL.forEach(function (f) { if (w[f] !== undefined && w[f] !== null) R.add(id + ':w' + w.i + '.' + f, w[f], now); });
      });
      READ_VD.forEach(function (f) { if (p.vd[f] !== undefined && p.vd[f] !== null) R.add(id + ':vd.' + f, p.vd[f], now); });
      if (p.vd.af !== undefined && p.vd.ar !== undefined) R.add(id + ':vd.bal', (p.vd.af - p.vd.ar) * 180 / Math.PI, now);
      if (p.gf) { R.add(id + ':gf.x', Math.abs(+p.gf.x || 0), now); R.add(id + ':gf.y', +p.gf.y || 0, now); }
      var sp = b.splits = computeSplits(m);
      if (sp) for (var k in sp) R.add(id + ':sp.' + k, sp[k], now);
      R.tick(now);
    } else b.splits = null;
    if (id === this.leadId() && p.gf) {   // peak G since the vehicle was (re)loaded or reset
      var key = id + ':' + p.lv;
      if (key !== this.peakKey) { this.peakKey = key; this.resetPeaks(); }
      var gx = Math.abs(+p.gf.x || 0), gy = +p.gf.y || 0, pk = this.peaks;
      pk.lat = Math.max(pk.lat || 0, gx);
      if (gy > 0) pk.brk = Math.max(pk.brk || 0, gy); else pk.acc = Math.max(pk.acc || 0, -gy);
    }
    return null;
  };
  VGSStore.prototype.resetPeaks = function () { this.peaks.lat = this.peaks.brk = this.peaks.acc = undefined; };
  // true when it changed what's shown
  VGSStore.prototype.setChain = function (c) {
    if (!c || typeof c.p !== 'number') return false;
    var ch = toArray(c.ch).map(Number), old = this.chain;
    this.chain = { p: c.p, ch: ch };
    if (c.p < 0) { this.bodies = {}; }
    return !old || old.p !== c.p || old.ch.join(',') !== ch.join(',');
  };
  VGSStore.prototype.hasData = function () { return Object.keys(this.bodies).length > 0; };
  VGSStore.prototype.clear = function () { this.bodies = {}; this.chain = null; this.read.clear(); };

  // the layout merged with the latest live values (wheel objects kept and updated in place)
  function mergeBody(b) {
    var st = b.st, d = b.d;
    if (!b.merged) {
      var copy = function (o) { var c = {}; for (var k in o) c[k] = o[k]; return c; };
      b.merged = {
        id: b.id, wheels: toArray(st.w).map(copy), sources: toArray(st.src).map(copy),
        dt: toArray(st.dt).map(function (n) { var c = copy(n); c.cp = toArray(n.cp).map(copy); return c; }),
        ext: st.ext, cg: st.cg, m: st.m
      };
    }
    var m = b.merged, dw = toArray(d.w), byI = null;
    m.wheels.forEach(function (w, k) {
      var src = dw[k];
      if (!src || src.i !== w.i) {   // not in the same order: find it by id
        if (!byI) { byI = {}; dw.forEach(function (x) { byI[x.i] = x; }); }
        src = byI[w.i];
      }
      // every live value the vehicle sends for this wheel; values it stopped sending go
      var old = w._live || [], now = [], key, j;
      for (j = 0; j < old.length; j++) w[old[j]] = undefined;
      if (src) for (key in src) if (!STATIC_KEYS[key]) { w[key] = src[key]; now.push(key); }
      w._live = now;
    });
    var ds = toArray(d.src);
    m.sources.forEach(function (s, k) { var x = ds[k] || {}; s.tc = x.tc; s.tf = x.tf; });
    var dg = toArray(d.dg);
    m.dt.forEach(function (n, k) {   // packed live state (see updateGraph in vgsTelemetry.lua)
      var code = +dg[k] || 0;
      var diff = code & 3;
      n.st = diff ? ['open', 'lsd', 'locked'][diff - 1] : undefined;
      n.dc = (code >> 2) & 1 ? 1 : undefined;
      n.cp.forEach(function (c, j) { c.o = (code >> (3 + j)) & 1 ? 1 : undefined; });
    });
    m.inp = d.inp; m.gf = d.gf; m.vd = d.vd;
    return m;
  }

  // The bodies to draw: the player's vehicle first, then whatever is coupled to it, front to back.
  VGSStore.prototype.frame = function () {
    var self = this, leadId = this.leadId();
    if (this.chain && this.chain.p < 0) return { bodies: [] };
    var lead = leadId !== undefined ? this.bodies[leadId] : undefined;
    if (!lead || !lead.st || !lead.d || lead.lv !== lead.d.lv) return { bodies: [] };
    var ids = (this.chain && this.chain.p === leadId && this.chain.ch.length) ? this.chain.ch.slice() : [leadId];
    if (!this.chain) toArray(lead.d.c).forEach(function (id) { if (ids.indexOf(+id) < 0) ids.push(+id); });
    var list = [];
    ids.forEach(function (id) {
      var b = self.bodies[id];
      if (!b || !b.st || !b.d || b.lv !== b.d.lv) return;
      if (b !== lead && lead.t - b.t > STALE_MS) return;
      list.push(b);
    });
    var ref = lead.d, hl = Math.hypot(+ref.hx || 0, +ref.hy || 0) || 1, hx = (+ref.hx || 0) / hl, hy = (+ref.hy || 1) / hl;
    list.forEach(function (b) { b.along = b === lead ? 0 : (b.d.px - ref.px) * hx + (b.d.py - ref.py) * hy; });
    list.sort(function (a, b) { return b.along - a.along; });
    return { bodies: list.map(mergeBody), splits: lead.splits };
  };

  VGSRenderer.synthDrivetrain = synthDrivetrain;   // used by the browser preview
  // the drivetrain glyphs, for the preview's legend and the README's images
  VGSRenderer.glyphs = {
    engine: drawEngine, motor: drawMotor,
    diff: drawDiff, gearbox: drawGearbox, disconnect: drawDisconnect,
    colours: DRIVETRAIN, torqueColour: torqueColour,
    tyre: drawTyre, slideColour: slideColour, inputArcs: drawInputArcs, travelColour: travelColour, steerScale: steerScale, steerK: steerK
  };
  VGSRenderer.Store = VGSStore;
  VGSRenderer.Units = Units;
  VGSRenderer.computeSplits = computeSplits;
  window.VGSRenderer = VGSRenderer;

  // ----- BeamNG app directive (skipped when running in a plain browser) -----
  if (!window.angular) return;

  // Every instance of the app on screen; the vehicles send the numbers-mode values while any of
  // them is in numbers mode.
  var instances = [];
  var PREF_KEY = 'vgsDisplay.numbers';
  function loadPref() { try { return window.localStorage.getItem(PREF_KEY) === '1'; } catch (e) { return false; } }
  function savePref(on) { try { window.localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch (e) { /* not available */ } }
  function lua(cmd) { if (window.bngApi && bngApi.engineLua) bngApi.engineLua(cmd); }
  function wantDetail() { return instances.some(function (it) { return it.opts.numbers; }); }
  function pushDetail() { lua('if extensions.vgsHub then extensions.vgsHub.setDetail(' + wantDetail() + ') end'); }
  function nowMsApp() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

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
        var store = new VGSStore();
        var units = new Units();
        var me = { opts: { numbers: loadPref(), units: units, read: store.read, peaks: store.peaks } };
        var opts = me.opts;
        instances.push(me);
        var pending = false, alive = true, lastData = 0, lastChain = 0;
        // Drawing happens once per screen refresh, with whatever arrived last: several updates
        // in one refresh (a truck and its trailer, a fast game) cost one draw, and nothing waits.
        var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (fn) { return setTimeout(fn, 16); };
        function render() {
          pending = false;
          if (!alive) return;
          var f = store.frame();
          opts.splits = f.splits;
          opts.peaks = store.peaks;
          try { renderer.draw(f, opts); } catch (e) { if (window.console) console.error('VGS Display:', e); }
        }
        function schedule() { if (!pending && alive) { pending = true; raf(render); } }
        function enableHub() {
          lua('extensions.load("vgsHub") if extensions.vgsHub then extensions.vgsHub.setEnabled(true) end');
          pushDetail();
        }
        enableHub();
        lua('settings.notifyUI()');   // for the unit settings
        schedule();

        scope.$on('VGSData', function (event, payload) {
          var t = nowMsApp();
          lastData = t;
          try {
            var ask = store.ingest(payload, t);
            if (ask !== null) lua('if extensions.vgsHub then extensions.vgsHub.requestLayout(' + ask + ') end');
          } catch (e) { if (window.console) console.error('VGS Display: bad update', e); }
          schedule();
        });
        scope.$on('VGSChain', function (event, chain) {
          lastChain = nowMsApp();
          try { if (store.setChain(chain)) schedule(); } catch (e) { if (window.console) console.error('VGS Display: bad chain message', e); }
        });
        scope.$on('SettingsChanged', function (event, data) { units.set(data && data.values); schedule(); });

        // Re-enable the hub if it goes quiet (level change, Lua reload, another instance closed).
        // While the game is paused the hub keeps talking, so the last picture stays up.
        var watchdog = setInterval(function () {
          var t = nowMsApp();
          if (t - Math.max(lastData, lastChain) > 2500) enableHub();
          if (t - lastData > 6000 && t - lastChain > 6000 && store.hasData()) { store.clear(); schedule(); }
        }, 1000);

        element.on('click', function (ev) {
          var r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
          var hit = (renderer.hits || []).filter(function (h) { return x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h; })[0];
          if (hit && hit.action === 'resetPeaks') { store.resetPeaks(); schedule(); return; }
          opts.numbers = !opts.numbers;
          savePref(opts.numbers);
          pushDetail();
          schedule();
        });
        var ro = window.ResizeObserver ? new ResizeObserver(schedule) : null;
        if (ro) ro.observe(element[0]);

        scope.$on('$destroy', function () {
          alive = false;
          clearInterval(watchdog);
          if (ro) ro.disconnect();
          instances.splice(instances.indexOf(me), 1);
          if (instances.length) pushDetail();
          else lua('if extensions.vgsHub then extensions.vgsHub.setEnabled(false) end');
        });
      }
    };
  }]);
})();

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
 * Click the app for the numbers mode: grip and load by every corner, and the understeer /
 * oversteer balance in words and degrees at the top of the circle.
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
    airborne:    'rgb(40, 130, 235)',
    airLight:    [120, 178, 245],       // nearly off the ground: a paler shade of the same blue, so the step to off the ground is natural   // inside of a wheel that's off the ground: a strong blue, unlike the white grip bar and the slide reds
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
  // The marker shows only when the car is off balance, in one of four states, each with its own
  // strong colour so it reads at a glance:
  //   near   the front nearing its limit (the understeer warning)   yellow
  //   rnear  the rear nearing its limit (the oversteer warning)      yellow
  //   limit  both ends at their limit together                       yellow
  //   under  understeer: the front past its peak, running wide       orange-red
  //   over   oversteer: the rear sliding more than the front         pink-magenta
  //   drift  a controlled drift: oversteer, caught (inp.dc; see TUNE.DRIFT_* in vgsTelemetry.lua)
  //                                                                  aquamarine
  //   pslide a controlled powerslide: all-wheel drive, all four sliding under power, held
  //          (see TUNE.PS_* in vgsTelemetry.lua)                     aquamarine
  // The colours were picked by simulation to stay distinct from each other and from the rim's
  // arcs with the common kinds of colour blindness, and differ in lightness as well as hue.
  // Neutral: no marker. Each state has a little hysteresis at its edges. Getting worse,
  // switching between understeer and oversteer, or catching or losing a drift shows at once;
  // easing from understeer back to the warning, or back to neutral, waits STATE_HOLD_MS, so a
  // quick flick stays up long enough to read.
  var TRAVEL_COLOUR = { neutral: [150, 210, 245], near: [255, 214, 10], rnear: [255, 214, 10], limit: [255, 214, 10], under: [255, 96, 24], over: [250, 130, 235], drift: [60, 230, 195], pslide: [60, 230, 195] };
  var UNDER_WARN = 0.35;   // must match US_WARN_SHARE in vgsTelemetry.lua
  // The balance counts as neutral between these: the marker is hidden and the balance readout
  // says nothing. Past them it's the front nearing its limit (below) or oversteer (above).
  var NEUTRAL_UNDER = -0.04, NEUTRAL_OVER = 0.15;
  var STATE_EDGE = 0.03;     // hysteresis: a state is left this far back inside its edge
  var DRIFT_ON = 0.6, DRIFT_OFF = 0.45;   // inp.dc: a drift counts as controlled from / until
  var DRIFT_CONFIRM_MS = 200; // a slide has to stay caught this long before it shows as a controlled drift
  var STATE_HOLD_MS = 450;   // a state shown stays at least this long unless something worse comes
  var STATE_BLEND_MS = 80;   // colour change between states
  var MARK_FADE_IN_MS = 30, MARK_FADE_OUT_MS = 120;
  var STATE_SEVERITY = { near: 1, rnear: 1, limit: 2, under: 3, over: 3, drift: 3, pslide: 3 };
  // The vehicle sends the state itself (inp.bs, see balanceStateOf in vgsTelemetry.lua): 1 the
  // front near its limit, 2 understeer, 3 the rear near its limit, 4 both at their limit,
  // 5 oversteer (a controlled drift with inp.dc), 6 a controlled powerslide (all-wheel drive).
  var BS_STATE = { 1: 'near', 2: 'under', 3: 'rnear', 4: 'limit', 5: 'over', 6: 'pslide' };
  // The state the balance is in (null = neutral). cur: the state shown now, for the hysteresis.
  // bs: the vehicle's own state, when it sends one; otherwise worked out from the balance.
  function balanceState(bal, dc, cur, bs) {
    if (bs !== undefined && bs !== null) {
      var st = BS_STATE[+bs] || null;
      if (st === 'over') return (+dc || 0) >= (cur === 'drift' ? DRIFT_OFF : DRIFT_ON) ? 'drift' : 'over';
      return st;
    }
    if (bal === undefined || bal === null || !isFinite(+bal)) return null;
    bal = +bal; dc = +dc || 0;
    var underSide = cur === 'under' || cur === 'near', overSide = cur === 'over' || cur === 'drift';
    if (bal <= -UNDER_WARN + (cur === 'under' ? STATE_EDGE * 1.5 : 0)) return 'under';
    if (bal <= NEUTRAL_UNDER + (underSide ? STATE_EDGE : 0)) return 'near';
    if (bal >= NEUTRAL_OVER - (overSide ? STATE_EDGE : 0)) return dc >= (cur === 'drift' ? DRIFT_OFF : DRIFT_ON) ? 'drift' : 'over';
    return null;
  }
  function stateRgb(st) { return TRAVEL_COLOUR[st] || TRAVEL_COLOUR.neutral; }
  function rgbCss(c) { return 'rgb(' + c.map(Math.round).join(', ') + ')'; }
  // The colour for a balance (no hold: still pictures, tests).
  function travelColour(bal, drift, bs) { return rgbCss(stateRgb(balanceState(bal, drift, null, bs))); }

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
  function markerSize(rPx) { return clamp(rPx * 0.1, 8, 16); }            // marker height (px)
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
  // The steering arc is hidden below this many degrees of rim and fully shown from the second
  // (about 0.55-1.2 % of steering in town, and 0.25-0.55 % from about 80 km/h up)
  var STEER_HIDE_DEG = 8 / 3, STEER_SHOW_DEG = 6;
  var STEER_VIS_K = 60;   // the stretch the visibility is judged on, at most (reached at about 80 km/h)
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
  // mk: the marker's state for this frame (VGSRenderer.markerState); without it (still pictures)
  // it's worked out from the balance alone
  function drawInputArcs(ctx, cx, cy, rPx, inp, mk) {
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
    if (!mk) { var s0 = balanceState(inp.bal, inp.dc, null, inp.bs); mk = { state: s0, rgb: stateRgb(s0), colour: travelColour(inp.bal, inp.dc, inp.bs), a: s0 ? 1 : 0 }; }
    var tv = hasTravel ? clamp(+inp.tv || 0, -4, 4) : 0, alpha = clamp(inp.ta === undefined ? 1 : +inp.ta, 0, 1) * mk.a;
    ctx.lineWidth = lw; ctx.lineCap = 'butt';
    var sk = +inp.k > 0 ? +inp.k : steerK(+inp.sr);   // the vehicle sends the scale's stretch
    // sd, tvd: the steering and the marker already on the scale, as they are this very frame
    // (see Motion); without them (still pictures), from the raw values
    var steerShown = inp.sd !== undefined ? clamp(+inp.sd, -1, 1) : steerScale(steer, sk);
    // A steering arc only a few degrees of rim long is the small corrections of driving straight:
    // it fades in from STEER_HIDE_DEG to STEER_SHOW_DEG of rim, so the rim stays clear on a straight.
    // Judged on the scale as stretched at about 80 km/h at most (STEER_VIS_K): at higher speed the
    // stretch magnifies the smallest jitter, so the threshold stays put in steering terms there.
    var steerDeg = steerScale(Math.abs(steer), Math.min(sk, STEER_VIS_K)) * 90;
    var steerVis = clamp((steerDeg - STEER_HIDE_DEG) / (STEER_SHOW_DEG - STEER_HIDE_DEG), 0, 1);
    steerVis = steerVis * steerVis * (3 - 2 * steerVis);
    if (steerVis > 0) {
      ctx.globalAlpha = steerVis;
      if (steerShown > 0) arc(INPUT.steer, TOP - steerShown * Q, TOP);        // left: counter-clockwise from the top
      else arc(INPUT.steer, TOP, TOP - steerShown * Q);                      // right: clockwise from the top
      ctx.globalAlpha = 1;
    }
    // ABS working: the brake arc pulses; traction control working: the throttle arc pulses
    var pulse = 0.5 + 0.5 * Math.sin(nowMs() / 1000 * 2 * Math.PI * PULSE_HZ);
    arc(+inp.abs ? mixRgb(INPUT.brake, INPUT.brakePulse, pulse) : INPUT.brake, BOTTOM, BOTTOM + brk * Q);
    arc(+inp.tcs ? mixRgb(INPUT.throttle, INPUT.throttlePulse, pulse) : INPUT.throttle, BOTTOM - thr * Q, BOTTOM);
    // clutch and handbrake: half as wide, along the outer edge, over the throttle and brake
    var clu = clamp(+inp.c || 0, 0, 1), hb = clamp(+inp.p || 0, 0, 1);
    r = rPx - lw / 4; ctx.lineWidth = lw / 2;
    arc(INPUT.handbrake, BOTTOM, BOTTOM + hb * Q);
    arc(INPUT.clutch, BOTTOM - clu * Q, BOTTOM);
    // the marker: a wedge pointing out at the steering arc, where the front is going, in its
    // state's colour, with a dark edge so it stands out against the arc and the dark circle. Between it and the end of the steering arc, a band in the same colour: the
    // gap you're steering past (understeer) or short of (oversteer), at a glance.
    if (hasTravel && alpha > 0) {
      var ang = TOP - (inp.tvd !== undefined ? +inp.tvd : steerScale(tv, sk)) * Q, mh = markerSize(rPx), tip = rPx - lw - 0.5, base = tip - mh, half = mh * 0.55;
      var ux = Math.cos(ang), uy = Math.sin(ang), px = -uy, py = ux, rgb = mk.rgb.map(Math.round).join(', ');
      var steerAng = TOP - steerShown * Q, gap = ang - steerAng;
      if (Math.abs(gap) > 0.03 && Math.abs(gap) < Math.PI) {
        var bw = clamp(lw * 0.6, 2, 4.5);
        ctx.beginPath(); ctx.arc(cx, cy, tip - bw / 2 - 0.5, Math.min(ang, steerAng), Math.max(ang, steerAng));
        ctx.lineWidth = bw; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(' + rgb + ', ' + (0.7 * alpha).toFixed(3) + ')'; ctx.stroke();
        ctx.lineCap = 'butt';
      }
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(cx + ux * tip, cy + uy * tip);
      ctx.lineTo(cx + ux * base + px * half, cy + uy * base + py * half);
      ctx.lineTo(cx + ux * base - px * half, cy + uy * base - py * half);
      ctx.closePath();
      ctx.fillStyle = mk.colour; ctx.fill();
      ctx.strokeStyle = 'rgba(8, 10, 14, 0.85)'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // G-force dot: the force the driver feels (braking pushes it forward/up, a left turn
  // pushes it right). The circle's edge is GF_MAX. Recent positions are redrawn as
  // fading ghosts, like a mouse trail, so the dot leaves a path.
  var GF_MAX = 1.5;          // g at the edge of the circle (road cars peak around 1 g)
  var TRAIL_MS = 1300;       // how long a ghost takes to fade out completely
  var TRAIL_STEP_MS = 12;    // at most one trail point this often, however fast the screen refreshes
  var GF_COLOUR = [240, 215, 130];   // soft butter yellow, to sit with the muted drivetrain colours
  var GF_ALPHA = 0.68;                // a little see-through, so the part underneath still shows
  var GF_RIM_ALPHA = 0.95;            // the rim is stronger so the dot keeps its shape
  var GF_HALO = 'rgba(8, 10, 14, 0.55)';   // a thin dark ring outside it, so it stands out on the grip bars and arcs

  function drawGForce(ctx, trail, cx, cy, R, gf) {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var gx = +gf.x || 0, gy = +gf.y || 0, mag = Math.hypot(gx, gy);
    if (mag > GF_MAX) { gx *= GF_MAX / mag; gy *= GF_MAX / mag; }   // pin to the edge
    // positions are stored as fractions of the radius so a resize doesn't smear the trail
    var last = trail[trail.length - 1];
    if (last && now - last.t < TRAIL_STEP_MS) { last.x = gx / GF_MAX; last.y = -gy / GF_MAX; }   // drawing faster than the trail needs
    else trail.push({ x: gx / GF_MAX, y: -gy / GF_MAX, t: now });
    while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();

    var dotR = clamp(R * 0.058, 3.5, 8.5), reach = R - dotR - 2;
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
      ctx.fillStyle = 'rgba(' + rgb + ', ' + (0.42 * life * life).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(cx + tk.x * reach, cy + tk.y * reach, dotR * (0.7 + 0.3 * life), 0, Math.PI * 2);
      ctx.fill();
    }
    var hx = cx + head.x * reach, hy = cy + head.y * reach;
    ctx.beginPath(); ctx.arc(hx, hy, dotR + 1.2, 0, Math.PI * 2);
    ctx.strokeStyle = GF_HALO; ctx.lineWidth = 1.5; ctx.stroke();                                   // dark halo
    ctx.beginPath(); ctx.arc(hx, hy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(' + rgb + ', ' + GF_ALPHA + ')'; ctx.fill();
    ctx.strokeStyle = 'rgba(' + rgb + ', ' + GF_RIM_ALPHA + ')'; ctx.lineWidth = 1.25; ctx.stroke();   // rim
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
        // nearly off the ground (wh.lf, 0..1): the inside turns pale blue as the load goes
        var lf = airborne ? 0 : clamp(+wh.lf || 0, 0, 1);
        if (lf > 0) {
          ctx.fillStyle = 'rgba(' + STYLE.airLight.join(', ') + ', ' + (lf * lf * (3 - 2 * lf)).toFixed(3) + ')';
          ctx.fillRect(-iw / 2, -ih / 2, iw, ih);
        }
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

  // The direction marker's state for this frame (see balanceState): which state is shown, after
  // the hold, its colour (blended briefly when the state changes) and how much of it shows
  // (fading in and out at neutral). { state, rgb, colour, a }
  VGSRenderer.prototype.markerState = function (inp) {
    var now = nowMs(), m = this.mark, bal = inp ? inp.bal : undefined, dc = inp ? inp.dc : undefined, bs = inp ? inp.bs : undefined;
    if (!m) {   // the first picture: straight to where it settles
      var s0 = balanceState(bal, dc, null, bs);
      m = this.mark = { cur: s0, cand: s0, candT: -Infinity, since: now, t: now, a: s0 ? 1 : 0, rgb: stateRgb(s0).slice(), from: stateRgb(s0).slice(), t0: -Infinity };
    }
    var dt = clamp(now - m.t, 0, 100); m.t = now;
    var cand = balanceState(bal, dc, m.cur, bs), cur = m.cur;
    if (cand !== m.cand) { m.cand = cand; m.candT = now; }
    // a drift or powerslide only counts as caught once it has stayed caught a moment: until then, oversteer
    if ((cand === 'drift' || cand === 'pslide') && cur !== cand && now - m.candT < DRIFT_CONFIRM_MS) cand = 'over';
    if (cand === cur) m.since = now;
    else {
      // at once: appearing, getting worse, or switching between understeer, oversteer and a
      // drift; held: easing to a milder state (understeer or oversteer back to a warning, one
      // warning to another) or back to neutral
      var at = cand && (!cur || STATE_SEVERITY[cand] > STATE_SEVERITY[cur] || (STATE_SEVERITY[cand] === 3 && STATE_SEVERITY[cur] === 3));
      if (at || now - m.since >= STATE_HOLD_MS) {
        if (cand) { m.from = m.rgb.slice(); m.t0 = cur ? now : -Infinity; }   // appearing: in its own colour at once
        m.cur = cand; m.since = now;
      }
    }
    if (m.cur) {
      var to = stateRgb(m.cur), k = clamp((now - m.t0) / STATE_BLEND_MS, 0, 1);
      for (var c = 0; c < 3; c++) m.rgb[c] = m.from[c] + (to[c] - m.from[c]) * k;
    }
    var target = m.cur ? 1 : 0;
    m.a += (target - m.a) * (1 - Math.exp(-dt / (target > m.a ? MARK_FADE_IN_MS : MARK_FADE_OUT_MS)));
    if (m.a < 0.01) m.a = 0;
    return { state: m.cur, rgb: m.rgb, colour: rgbCss(m.rgb), a: m.a };
  };

  VGSRenderer.prototype.fit = function () {
    var c = this.canvas, dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth || c.width, h = c.clientHeight || c.height;
    var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  };

  // ===== Numbers mode ======================================================
  // Click the app to switch it on. Beside every corner: grip in use and the load on it. At the
  // top of the circle: the balance in words, in the marker's colour, with how many degrees more
  // one axle is slipping than the other.

  // Weight units follow BeamNG's own unit settings, like its other apps.
  function Units() { this.weight = 'kg'; }
  Units.prototype.set = function (v) { if (v && v.uiUnitWeight) this.weight = v.uiUnitWeight; };
  Units.prototype.load = function (newtons) {
    var kg = newtons / 9.81;
    return this.weight === 'lb' ? { v: kg * 2.20462262, u: 'lb' } : { v: kg, u: 'kg' };
  };
  var DEFAULT_UNITS = new Units();

  // Text that changes every frame can't be read, so numbers are averaged over a short window
  // and refreshed a few times a second. The drawing itself shows every update as it arrives.
  var READ_MS = 150;
  function Readouts() { this.acc = {}; this.val = {}; this.t0 = 0; }
  Readouts.prototype.add = function (key, v) {
    if (v === undefined || v === null || !isFinite(v)) return;
    var a = this.acc[key] || (this.acc[key] = { s: 0, n: 0 });
    a.s += +v; a.n++;
    if (!(key in this.val)) this.val[key] = +v;   // the first value at once
  };
  Readouts.prototype.tick = function (now) {
    if (now - this.t0 < READ_MS) return;
    this.t0 = now;
    for (var k in this.acc) {
      var a = this.acc[k];
      if (a.n) { this.val[k] = a.s / a.n; a.s = 0; a.n = 0; }
      else { delete this.val[k]; delete this.acc[k]; }   // gone (numbers mode off, wheel lost)
    }
  };
  Readouts.prototype.get = function (key, fallback) { return key in this.val ? this.val[key] : fallback; };
  Readouts.prototype.clear = function () { this.acc = {}; this.val = {}; };

  var DIM_TEXT = 'rgba(255, 255, 255, 0.55)';
  var FONT = '"Noto Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
  function font(px, weight) { return (weight || 400) + ' ' + px.toFixed(1) + 'px ' + FONT; }
  function fmt(v, d) {
    if (v === undefined || v === null || !isFinite(v)) return '–';
    var s = (+v).toFixed(d || 0);
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);   // no "-0"
    return s.replace('-', '−');
  }
  function text(ctx, s, x, y, px, weight, colour, align) {
    ctx.font = font(px, weight); ctx.fillStyle = colour;
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
    return ctx.measureText(s).width;
  }
  function measure(ctx, s, px, weight) { ctx.font = font(px, weight); return ctx.measureText(s).width; }

  // Readouts beside each corner: grip in use, and the load on it. A dual set shows its
  // hardest-working tyre and the load on the whole set.
  function cornerFont(tyreH) { return clamp(tyreH * 0.33, 10, 15); }
  function drawCornerReadouts(ctx, p, dims, circle, opts) {
    var body = p.body, R = opts.read, U = opts.units || DEFAULT_UNITS, done = {}, blocks = [];
    function rd(w, f) {
      var raw = w[f];
      if (raw === undefined || raw === null) return undefined;
      return R ? R.get(body.id + ':w' + w.i + '.' + f, +raw) : +raw;
    }
    body.wheels.forEach(function (wh) {
      if (wh._outer === false) return;
      var set = wh._set ? wh._set.wheels : [wh], seen = {}, list = [];
      set.forEach(function (w) { if (!seen[w.i]) { seen[w.i] = true; list.push(w); } });
      var key = list.map(function (w) { return w.i; }).join(',');
      if (done[key]) return;
      done[key] = true;
      var grip = 0, load;
      list.forEach(function (w) {
        grip = Math.max(grip, rd(w, 'g') || 0);
        var f = rd(w, 'fz'); if (f !== undefined) load = (load || 0) + f;
      });
      var sliding = list.some(function (w) { return !!+w.e; });
      var airborne = list.every(function (w) { return !!+w.a; });
      var broken = list.every(function (w) { return !!+w.b; });
      var pt = p.wheelPoint(wh), d = dims(wh), onLeft = !!(wh._set && wh._set.side < 0);
      var fs = cornerFont(d.h), small = fs * 0.88;
      var lines = [];
      if (broken) lines.push({ s: 'broken', px: small, w: 600, c: DIM_TEXT });
      else {
        var light = Math.max.apply(null, list.map(function (w) { return +w.lf || 0; }));
        var gc = airborne ? STYLE.airborne : (light >= 0.5 ? 'rgb(' + STYLE.airLight.join(', ') + ')'
          : (sliding ? slideColour(Math.max.apply(null, list.map(function (w) { return +w.ex || 0; }))) : STYLE.text));
        lines.push({ s: Math.round(grip * 100) + '%', px: fs, w: 600, c: gc });
        if (load !== undefined && !circle.compact) { var lu = U.load(Math.max(0, load)); lines.push({ s: fmt(lu.v, 0) + ' ' + lu.u, px: small, w: 400, c: DIM_TEXT }); }
      }
      var widest = 0, height = 0;
      lines.forEach(function (l) { l.width = measure(ctx, l.s, l.px, l.w); widest = Math.max(widest, l.width); height += l.px * 1.2; });
      blocks.push({ wh: wh, pt: pt, d: d, onLeft: onLeft, lines: lines, widest: widest, height: height, y0: pt.y - height / 2 });
    });
    // Readouts that would overlap on the same side (a tandem axle) are spread apart, as a group
    // centred where they would have been.
    [true, false].forEach(function (left) {
      var side = blocks.filter(function (b) { return b.onLeft === left; }).sort(function (a, b) { return a.y0 - b.y0; });
      var groups = [];
      side.forEach(function (b) {
        groups.push({ list: [b], h: b.height, mid: b.y0 + b.height / 2, n: 1 });
        while (groups.length > 1) {
          var g2 = groups[groups.length - 1], g1 = groups[groups.length - 2];
          if (g1.mid + g1.h / 2 + 1 <= g2.mid - g2.h / 2) break;
          g1.mid = (g1.mid * g1.n + g2.mid * g2.n) / (g1.n + g2.n);
          g1.n += g2.n; g1.h += 1 + g2.h; g1.list = g1.list.concat(g2.list);
          groups.pop();
        }
      });
      groups.forEach(function (g) {
        var y = g.mid - g.h / 2;
        g.list.forEach(function (b) { b.y0 = y; y += b.height + 1; });
      });
    });
    blocks.forEach(function (b) {
      var wh = b.wh, pt = b.pt, d = b.d, onLeft = b.onLeft, widest = b.widest, height = b.height;
      var r = dotRadius(d.w);
      var clear = d.w / 2 + Math.abs(Math.sin(+wh.s || 0)) * d.h / 2 + Math.max(3, r) + 2 * r + 4;
      var tx = onLeft ? pt.x - clear : pt.x + clear, align = onLeft ? 'right' : 'left';
      // keep the block inside the circle; if that would put it over the tyre, put it on the
      // tyre's inner side instead
      var y0 = b.y0, worst = Math.max(Math.abs(y0 - circle.cy), Math.abs(y0 + height - circle.cy));
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
      b.lines.forEach(function (l) {
        y += l.px * 1.2;
        text(ctx, l.s, tx, y - l.px * 0.24, l.px, l.w, l.c, align);
      });
      ctx.restore();
    });
  }

  // The balance in words, at the top of the circle, in the marker's colour: Neutral, Front near
  // limit (the understeer warning), Understeer, Oversteer or Controlled drift, with how many
  // degrees more the front (understeer) or rear (oversteer) is slipping than the other axle.
  // The balance, on two lines at the top of the circle, in the marker's colour: the degrees on
  // top, large, and the words under them. Both lines always sit at the same height.
  function balanceFont(rPx) { return clamp(rPx * 0.058, 8.5, 11); }   // the words: about the size of the grip readouts
  function degreeFont(rPx) { return balanceFont(rPx) * 1.15; }       // the degrees, a touch bigger
  var SHORT_WORD = { 'Understeer': 'Under', 'Front near limit': 'Front near', 'Rear near limit': 'Rear near', 'At the limit': 'At limit', 'Oversteer': 'Over', 'Controlled drift': 'Drift', 'Controlled powerslide': 'Powerslide', 'Neutral': 'Neutral' };
  // { word, deg (text, or '' when there's nothing to show), colour }, or null when the marker is hidden
  var STATE_WORD = { near: 'Front near limit', rnear: 'Rear near limit', limit: 'At the limit', under: 'Understeer', over: 'Oversteer', drift: 'Controlled drift', pslide: 'Controlled powerslide' };
  // mk: the marker's state this frame (so the words and the marker always agree, and hold together)
  function balanceStatus(m, R, compact, mk) {
    var inp = m.inp || {}, vd = m.vd || {}, bal = inp.bal;
    if (bal === undefined || bal === null) return null;
    var st = mk ? mk.state : balanceState(bal, inp.dc, null, inp.bs);
    var word = st ? STATE_WORD[st] : 'Neutral', colour = st ? (mk ? mk.colour : travelColour(bal, inp.dc, inp.bs)) : STYLE.text;
    var diff;
    if (vd.af !== undefined && vd.ar !== undefined && vd.af !== null && vd.ar !== null) {
      diff = (vd.af - vd.ar) * 180 / Math.PI;
      if (R) diff = R.get(m.id + ':vd.bal', diff);
    }
    if (st === 'pslide' && vd.sl !== undefined && vd.sl !== null) {   // a powerslide: how far it's sliding
      diff = vd.sl * 180 / Math.PI;
      if (R) diff = R.get(m.id + ':vd.sl', diff);
    }
    var deg = (word !== 'Neutral' && diff !== undefined) ? fmt(Math.abs(diff), 1) + '°' : '';
    return { word: compact ? SHORT_WORD[word] : word, deg: deg, colour: colour, neutral: word === 'Neutral' };
  }
  // How far down from the top of the inner circle a line of text this wide has to sit so its
  // corners stay inside it (clear of the marker on the rim).
  function chordDrop(inner, width) {
    var half = width / 2 + 4;
    return half >= inner ? inner : inner - Math.sqrt(inner * inner - half * half);
  }
  // Where the two lines go, worked out for the longest text so nothing moves as it changes.
  var balanceCache = { key: null, val: null };
  function balanceLayout(ctx, rPx, inner, compact) {
    var key = rPx.toFixed(2) + '|' + inner.toFixed(2) + '|' + compact;
    if (balanceCache.key === key) return balanceCache.val;
    balanceCache.key = key;
    return (balanceCache.val = balanceLayoutNow(ctx, rPx, inner, compact));
  }
  function balanceLayoutNow(ctx, rPx, inner, compact) {
    var fs = balanceFont(rPx), dfs = degreeFont(rPx), h1 = dfs * 1.0, h2 = fs * 1.15;
    var w1 = measure(ctx, '88.8°', dfs, 700), w2 = measure(ctx, compact ? 'Powerslide' : 'Controlled powerslide', fs, 600);
    var drop = Math.max(chordDrop(inner, w1), chordDrop(inner, w2) - h1) + 1;
    return { fs: fs, dfs: dfs, drop: drop, h1: h1, band: drop + h1 + h2 + fs * 0.25 };
  }
  // the band at the top of the circle the balance needs
  function balanceBand(ctx, rPx, inner, compact) { return balanceLayout(ctx, rPx, inner, compact).band; }
  function drawBalance(ctx, m, cx, cy, inner, rPx, opts, compact, mk) {
    var st = balanceStatus(m, opts.read, compact, mk);
    if (!st || st.neutral) return;   // nothing to say while the car is balanced
    var L = balanceLayout(ctx, rPx, inner, compact), top = cy - inner + L.drop;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'; ctx.shadowBlur = 3;
    if (st.deg) text(ctx, st.deg, cx, top + L.dfs * 0.9, L.dfs, 700, st.colour, 'center');
    text(ctx, st.word, cx, top + L.h1 + L.fs, L.fs, 600, st.colour, 'center');
    ctx.restore();
  }


  // ===== Renderer ==========================================================
  // The wheel list to draw, and the layout worked out from it, are kept with the body and reused
  // while its layout stays the same (only the live values are refreshed), so a frame doesn't
  // redo the layout.
  function prepareBodies(data) {
    return toArray(data && data.bodies)
      .map(function (b) {
        var prep = b._prep;
        if (!prep || prep.from !== b.wheels || prep.sources !== b.sources || prep.ext !== b.ext) {
          var wheels = [], dups = [];
          toArray(b.wheels).forEach(function (w, k) {
            if (w.i === undefined) w.i = k;   // older payloads without ids
            // a wheel standing in for a dual pair (w.nt = 2) is drawn as that many tyres;
            // they share its data and are laid out side by side like any dual set
            var n = clamp(Math.round(+w.nt || 1), 1, 4);
            wheels.push(w);
            for (var c = 1; c < n; c++) { var d = Object.assign({}, w); wheels.push(d); dups.push([d, w]); }
          });
          prep = { from: b.wheels, sources: b.sources, ext: b.ext, wheels: wheels, dups: dups, geo: null };
          try { Object.defineProperty(b, '_prep', { value: prep, writable: true, configurable: true }); } catch (e) { b._prep = prep; }
        } else {
          prep.dups.forEach(function (pr) { var d = pr[0], w = pr[1]; for (var key in w) if (key.charAt(0) !== '_') d[key] = w[key]; });
        }
        return { id: b.id, wheels: prep.wheels, sources: toArray(b.sources), inp: b.inp, gf: b.gf, ext: b.ext, dt: b.dt, vd: b.vd, cg: b.cg, m: b.m, _prep: prep };
      })
      .filter(function (b) { return b.wheels.length > 0; });
  }

  // draw(data, opts): data = { bodies: [...] } (lead vehicle first); opts.numbers switches the
  // numbers mode on (opts.read: averaged readouts, opts.units: weight units).
  VGSRenderer.prototype.draw = function (data, opts) {
    opts = opts || {};
    var size = this.fit(), ctx = this.ctx, W = size.w, H = size.h;
    var trail = this.gTrail;
    ctx.clearRect(0, 0, W, H);
    var bodies = prepareBodies(data);
    if (!bodies.length) { trail.length = 0; this.leadId = undefined; drawEmpty(ctx, W, H); return; }
    // a different vehicle: no trail from the old one
    if (!bodies[0].gf || (this.leadId !== undefined && bodies[0].id !== this.leadId)) trail.length = 0;
    this.leadId = bodies[0].id;
    // every vehicle is laid out from its real footprint when the vehicle reports one
    bodies.forEach(function (b) { b.geo = b._prep.geo || (b._prep.geo = bodyGeometry(b.wheels, b.sources, b.ext)); });

    var scale, placements = [];
    // The big circle always fills the app; vehicles are scaled to fit inside it, clear of the
    // input arcs on its rim.
    var rPx = Math.max(4, Math.min(W, H) / 2 - 2), ccx = W / 2, ccy = H / 2;
    var inner = rPx - clamp(rPx * 0.05, 3, 7) - markerSize(rPx) - 2;
    // numbers mode: a band at the top of the circle for the balance
    // In a very small app (under about 125 px) the readouts are just the grip, and the balance
    // words are shortened.
    var compact = rPx < COMPACT_BELOW;
    var band = opts.numbers ? balanceBand(ctx, rPx, inner, compact) : 0;
    ctx.beginPath(); ctx.arc(ccx, ccy, rPx, 0, Math.PI * 2);
    ctx.fillStyle = STYLE.panelFill; ctx.fill();
    ctx.strokeStyle = STYLE.panelStroke; ctx.lineWidth = 1.5; ctx.stroke();
    var mk = this.markerState(bodies[0].inp);
    drawInputArcs(ctx, ccx, ccy, rPx, bodies[0].inp, mk);

    function outline(b, ox, oy) {
      var hw = b.geo.boxHalfW * scale, hh = b.geo.boxHalfH * scale;
      roundRect(ctx, ox - hw, oy - hh, hw * 2, hh * 2, Math.min(6, hw * 0.2));
      ctx.strokeStyle = STYLE.panelStroke; ctx.lineWidth = 1; ctx.stroke();
    }

    // in numbers mode the vehicle is drawn a little smaller, to make room for the readouts and
    // the balance at the top
    if (bodies.length === 1) {
      // centred on the vehicle's body, one scale for everything (true proportions)
      scale = inner / fitRadius(bodies[0]);
      if (opts.numbers) {   // worked out once per layout and size
        var sk = [scale.toFixed(4), inner.toFixed(2), band.toFixed(2), compact].join('|'), sc = this.shrinkCache;
        if (!sc || sc.geo !== bodies[0].geo || sc.key !== sk) sc = this.shrinkCache = { geo: bodies[0].geo, key: sk, k: readoutShrink(ctx, bodies[0], scale, inner, band, compact) };
        scale *= sc.k;
      }
      if (bodies[0].geo.hasExt) outline(bodies[0], ccx, ccy);
      placements.push({ body: bodies[0], ox: ccx, oy: ccy });
    } else {
      // tractor + trailer, articulated sections: stacked front to back, one shared scale (in
      // numbers mode a little smaller, and moved down clear of the balance)
      var maxHalfW = 0, totalH = BODY_GAP * (bodies.length - 1);
      bodies.forEach(function (b) { maxHalfW = Math.max(maxHalfW, b.geo.halfW); totalH += b.geo.halfH * 2; });
      scale = (inner - band) / Math.hypot(maxHalfW, totalH / 2) * (opts.numbers ? NUMBERS_SHRINK : 1);
      var y = ccy + band / 2 - totalH * scale / 2, prevBottom = null;
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
    // Pass 2: tyres and assist dots on top. Pass 3 (numbers mode): readouts and the balance.
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
      var circle = { cx: ccx, cy: ccy, r: inner, compact: compact };
      placements.forEach(function (p) { drawCornerReadouts(ctx, p, dims, circle, opts); });
      drawBalance(ctx, bodies[0], ccx, ccy, inner, rPx, opts, compact, mk);
    }
  };
  var NUMBERS_SHRINK = 0.86;   // stacked vehicles in numbers mode
  var COMPACT_BELOW = 62;      // circle radius (px) below which the numbers go compact

  // How much smaller to draw a lone vehicle in numbers mode so every corner's readout fits
  // beside its tyre inside the circle, and the vehicle stays clear of the balance band at the top.
  function readoutShrink(ctx, body, scale, inner, band, compact) {
    var g = body.geo, sample = compact ? '100%' : '1888 kg', nLines = compact ? 1 : 2;
    for (var k = 1; k >= 0.35; k -= 0.025) {
      var s2 = scale * k, ok = g.boxHalfH * s2 <= inner - band - 2;
      for (var i = 0; i < body.wheels.length && ok; i++) {
        var w = body.wheels[i];
        if (w._outer === false) continue;
        var tw = Math.max(w._wd * s2, MIN_TYRE_W), th = Math.max(w._len * s2, MIN_TYRE_L);
        var fs = cornerFont(th), textW = measure(ctx, sample, compact ? fs : fs * 0.88, compact ? 600 : 400), textH = fs * 1.2 * nLines;
        var x = Math.abs(w._mx - g.cx) * s2 + tw / 2 + dotRadius(tw) * 3 + 7 + textW;
        var y = Math.abs(+w.y - g.cy) * s2 + textH / 2;
        if (x * x + y * y > (inner - 3) * (inner - 3)) ok = false;
        if (+w.y > g.cy && (+w.y - g.cy) * s2 + textH / 2 > inner - band - 2) ok = false;   // a front readout under the band
      }
      if (ok) return k;
    }
    return 0.35;
  }

  // ===== Motion between updates ===========================================
  // The app draws at the screen's own rate, which rarely matches the rate updates arrive at
  // (game frames vary, the UI may run slower, messages arrive in clumps). Showing each update
  // only as it lands makes moving parts step unevenly. Instead every moving value (the
  // direction marker, the steering and pedal arcs, the G-force dot, the tyres' steering) is
  // carried forward from its last update at the speed it was moving, for at most about one
  // update's time, and when the next update lands any small difference is blended out over a
  // few milliseconds rather than jumped. Nothing waits for a later update, so this adds no
  // delay; it only fills the gaps between updates.
  var MOTION_VEL_TAU = 20;    // ms: smoothing of each value's speed
  var MOTION_AHEAD = 2.0, MOTION_AHEAD_MIN = 12, MOTION_AHEAD_MAX = 80;   // how far a value is carried forward: updates' spacing x, limits in ms
  var MOTION_BLEND = 1.2, MOTION_BLEND_MIN = 6, MOTION_BLEND_MAX = 40;    // how fast a difference is blended out: updates' spacing x, limits in ms
  var MOTION_JUMP = 3;        // a step this many times the one before counts as a jump
  var CLOCK_DRIFT = 0.01;     // how fast (ms per ms) the clock match may move to later deliveries

  // One moving value. Times are the app's own clock (ms); snap: a jump bigger than this is shown
  // at once (a reset, a vehicle switch); lo/hi: limits.
  function Channel(snap, lo, hi) { this.t = null; this.snap = snap; this.lo = lo; this.hi = hi; }
  Channel.prototype.reset = function () { this.t = null; };
  Channel.prototype.base = function (now, ahead) {
    var age = now - this.t, x;
    if (age <= 0) x = this.v;   // stamped a touch after 'now' (clock jitter): as is
    else if (age <= ahead) x = this.v + this.vel * age;
    else x = this.v + this.vel * ahead;   // no update for a while (a hitch, paused): stop there
    return x;
  };
  Channel.prototype.at = function (now, m) {
    if (this.t === null) return undefined;
    var x = this.base(now, m.ahead);
    if (this.e) x += this.e * Math.exp(-(now - this.te) / this.tauE);
    if (this.lo !== undefined && x < this.lo) x = this.lo;
    if (this.hi !== undefined && x > this.hi) x = this.hi;
    return x;
  };
  Channel.prototype.push = function (t, v, now, m) {
    if (v === undefined || v === null || !isFinite(v)) { this.t = null; return; }
    v = +v;
    if (this.t === null) { this.t = t; this.v = v; this.vel = 0; this.d1 = 0; this.e = 0; this.te = now; this.tauE = m.blend; return; }
    var shown = this.at(now, m), dt = t - this.t, jump = false;
    if (dt > 0.5 && dt < 250) {
      // The speed to carry it forward at. A step far bigger than the one before (a key press, a
      // reset) is a jump, not motion: it isn't carried on past where it really is.
      var d0 = (v - this.v) / dt, d1 = this.d1;
      jump = Math.abs(d0) > MOTION_JUMP * Math.abs(d1) && Math.abs(d0 - d1) * dt > this.snap * 0.05;
      var raw = jump ? 0 : d0;
      this.d1 = d0;
      this.vel += (raw - this.vel) * (1 - Math.exp(-dt / MOTION_VEL_TAU));
    } else if (dt >= 250 || dt < -250) { this.vel = 0; this.d1 = 0; }   // a gap (pause): start again from rest
    this.t = Math.max(t, this.t); this.v = v;
    var e = shown - this.base(now, m.ahead);
    this.e = (Math.abs(e) > this.snap) ? 0 : e; this.te = now;
    this.tauE = jump ? Math.max(MOTION_BLEND_MIN, m.blend / 3) : m.blend;   // a jump catches up faster
  };

  // A vehicle's moving values, and how its clock (the update's ts) maps onto the app's.
  function Motion() {
    this.off = undefined; this.lastTs = undefined; this.lastNow = 0; this.interval = 16.7;
    this.ahead = MOTION_AHEAD_MIN; this.blend = MOTION_BLEND_MIN;
    this.ch = {};
  }
  Motion.prototype.chan = function (key, snap, lo, hi) {
    return this.ch[key] || (this.ch[key] = new Channel(snap, lo, hi));
  };
  // When (on the app's clock) an update stamped ts happened. The match is the quickest delivery
  // seen, creeping later only slowly, so a late or clumped delivery doesn't move it.
  Motion.prototype.when = function (ts, now) {
    if (typeof ts !== 'number' || !isFinite(ts)) { this.lastNow = now; return now; }
    var o = now - ts;
    if (this.off === undefined || Math.abs(o - this.off) > 1000) this.off = o;   // first, or a new clock
    else this.off = Math.min(o, this.off + CLOCK_DRIFT * Math.max(0, now - this.lastNow));
    if (this.lastTs !== undefined) {
      var dt = ts - this.lastTs;
      if (dt > 0.5 && dt < 250) this.interval += (dt - this.interval) * 0.1;
    }
    this.lastTs = ts; this.lastNow = now;
    this.ahead = clamp(this.interval * MOTION_AHEAD, MOTION_AHEAD_MIN, MOTION_AHEAD_MAX);
    this.blend = clamp(this.interval * MOTION_BLEND, MOTION_BLEND_MIN, MOTION_BLEND_MAX);
    return ts + this.off;
  };
  // Feed one update (p) with its layout merged in (m).
  Motion.prototype.feed = function (p, m, now) {
    var t = this.when(p.ts, now), self = this, inp = p.inp || {};
    var sk = +inp.k > 0 ? +inp.k : steerK(+inp.sr);
    this.chan('sd', 0.6).push(t, steerScale(clamp(+inp.s || 0, -1, 1), sk), now, this);
    var tvd = (inp.tv === undefined || inp.tv === null) ? undefined : steerScale(clamp(+inp.tv || 0, -4, 4), sk);
    this.chan('tvd', 0.8).push(t, tvd, now, this);
    ['t', 'b', 'c', 'p'].forEach(function (k) { self.chan(k, 2, 0, 1).push(t, inp[k] === undefined ? undefined : +inp[k] || 0, now, self); });
    if (p.gf) { this.chan('gx', 1.0).push(t, +p.gf.x || 0, now, this); this.chan('gy', 1.0).push(t, +p.gf.y || 0, now, this); }
    else { this.chan('gx').reset(); this.chan('gy').reset(); }
    toArray(m.wheels).forEach(function (w) { self.chan('s' + w.i, 0.5).push(t, w.s === undefined ? undefined : +w.s, now, self); });
  };
  // Put the values for the moment 'now' into the merged body (its live values are refreshed from
  // the latest update first, so nothing builds up).
  Motion.prototype.apply = function (m, d, now) {
    var self = this, inp = d.inp, shown = m._inpShown || (m._inpShown = {}), k;
    if (inp) {
      for (k in shown) delete shown[k];
      for (k in inp) shown[k] = inp[k];
      var sd = this.chan('sd').at(now, this), tvd = this.chan('tvd').at(now, this);
      if (sd !== undefined) shown.sd = sd;
      if (tvd !== undefined && inp.tv !== undefined && inp.tv !== null) shown.tvd = tvd;
      ['t', 'b', 'c', 'p'].forEach(function (c) { var v = self.chan(c).at(now, self); if (v !== undefined) shown[c] = v; });
      m.inp = shown;
    } else m.inp = inp;
    if (d.gf) {
      var gx = this.chan('gx').at(now, this), gy = this.chan('gy').at(now, this);
      m.gf = { x: gx === undefined ? d.gf.x : gx, y: gy === undefined ? d.gf.y : gy };
    } else m.gf = d.gf;
    toArray(m.wheels).forEach(function (w) {
      var c = self.ch['s' + w.i], v = c && c.at(now, self);
      if (v !== undefined) w.s = v;
    });
  };

  // ===== Data from the game ================================================
  // Each displayed vehicle sends its own updates ('VGSData', straight from its Lua); the hub says
  // which vehicles make up the player's chain ('VGSChain'). The layout comes as a separate block
  // (st) when it changes and every couple of seconds; it's kept per vehicle and merged with the
  // live values into the shape the renderer draws.
  // layout fields a live update never overwrites (everything else it sends is copied as is)
  var STATIC_KEYS = { i: 1, n: 1, nt: 1, rd: 1, wd: 1, x: 1, y: 1 };
  var READ_WHEEL = ['g', 'fz'];
  var STALE_MS = 1500;   // a coupled body this far behind the lead vehicle's updates is dropped

  function VGSStore() {
    this.bodies = {};      // id -> { id, st, lv, d (latest update), t (ms), merged }
    this.chain = null;     // { p: player vehicle id (-1 = none), ch: [ids] }
    this.read = new Readouts();
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
    if (b.d && b.d.lv !== p.lv && b.motion) b.motion = null;   // a reset: no motion carried over
    b.d = p; b.t = now;
    var ask = null;
    if (!b.st || b.lv !== p.lv) {   // updates without (the current) layout: ask, at most once a second
      if (!this.layoutAsked[p.id] || now - this.layoutAsked[p.id] > 1000) { this.layoutAsked[p.id] = now; ask = p.id; }
      return ask;
    }
    var m = mergeBody(b), R = this.read, id = p.id;
    (b.motion || (b.motion = new Motion())).feed(p, m, now);
    if (p.vd) {   // numbers mode: feed the readouts
      toArray(m.wheels).forEach(function (w) {
        READ_WHEEL.forEach(function (f) { if (w[f] !== undefined && w[f] !== null) R.add(id + ':w' + w.i + '.' + f, w[f]); });
      });
      if (p.vd.af !== undefined && p.vd.ar !== undefined) R.add(id + ':vd.bal', (p.vd.af - p.vd.ar) * 180 / Math.PI);
      if (p.vd.sl !== undefined && p.vd.sl !== null) R.add(id + ':vd.sl', p.vd.sl * 180 / Math.PI);
      R.tick(now);
    }
    return null;
  };
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
    b.mergedFrom = d;
    return m;
  }
  // the merged body with its moving values as they are at 'now' (when given)
  function shownBody(b, now) {
    var m = (b.mergedFrom === b.d && b.merged) ? b.merged : mergeBody(b);
    if (now !== undefined && b.motion) b.motion.apply(m, b.d, now);
    return m;
  }

  // The bodies to draw: the player's vehicle first, then whatever is coupled to it, front to back.
  VGSStore.prototype.frame = function (now) {
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
    return { bodies: list.map(function (b) { return shownBody(b, now); }) };
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
  VGSRenderer.balanceStatus = balanceStatus;
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
  var ANIMATE_AFTER_MS = 1500;   // keep drawing every refresh this long after the last update (the trail fades)

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
        var me = { opts: { numbers: loadPref(), units: units, read: store.read } };
        var opts = me.opts;
        instances.push(me);
        var pending = false, alive = true, lastData = 0, lastChain = 0;
        // While updates are coming in, the app draws on every screen refresh, with the moving
        // parts where they are at that moment (see Motion), so motion is as smooth as the screen
        // allows whatever rate the updates come at. Several updates in one refresh cost one
        // draw. When updates stop (paused, no vehicle) it carries on just long enough for the
        // G-force trail to fade, then draws only when something changes.
        var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (fn) { return setTimeout(fn, 16); };
        function render() {
          pending = false;
          if (!alive) return;
          var t = nowMsApp();
          try { renderer.draw(store.frame(t), opts); } catch (e) { if (window.console) console.error('VGS Display:', e); }
          if (t - lastData < ANIMATE_AFTER_MS) schedule();
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

        element.on('click', function () {
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

/* VGS Display — BeamNG UI app
 * ---------------------------------------------------------------------------
 * Draws every wheel where it sits on the vehicle (one body = circle, several
 * coupled bodies = stacked panels, front first).
 *   Inner bar  : grip in use, growing from the centre; solid red = grip exceeded,
 *                greyish red just past the limit, deeper and more saturated as it slides more
 *   Outline    : torque applied — grey neutral, greener with drive, redder with braking
 *   Rotation   : each wheel's live steering angle
 *   Underneath : axles (brighter when driven), chassis spine, engine block or
 *                electric motors where they sit, driveshafts and differentials
 *                to the wheels each one drives (tinted by the torque flowing)
 *   Dot outside a wheel : red ABS / blue ESC acting on that wheel
 *   Dot under the engine : green, traction control intervening
 *   No dots when nothing is intervening
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
    spine:      'rgba(255, 255, 255, 0.13)',
    axle:       'rgba(255, 255, 255, 0.22)',
    axleDriven: 'rgba(255, 255, 255, 0.5)',
    diff:       'rgba(236, 240, 246, 0.75)',
    engine:     'rgba(236, 240, 246, 0.88)',
    engineEdge: 'rgba(0, 0, 0, 0.55)',
    motor:      'rgba(236, 240, 246, 0.88)'
  };

  // Driver-assist dots. Per wheel (wheel.iv): 1 ABS, 3 ESC; hidden when 0.
  // Traction control acts on the engine, so it's one dot under the engine (body.tc).
  var ASSIST = {
    1: { colour: 'rgb(255, 60, 50)',  rank: 1 },
    3: { colour: 'rgb(60, 150, 255)', rank: 2 }
  };
  var ASSIST_TC = 'rgb(70, 225, 95)';
  function dotRadius(tyreW) { return clamp(tyreW * 0.3, 2.5, 4.5); }

  // Drawing sizes in metres (scaled with the vehicle)
  var TYRE_W = 0.34, TYRE_H = 0.8, PAD = 0.28, BODY_GAP = 0.45;
  var ENGINE_W = 0.62, ENGINE_H = 0.48, MOTOR_R = 0.2, DIFF = 0.2;
  var AXLE_TOL = 0.3; // wheels within this many metres fore/aft share an axle
  var DOT_SPACE = 0.3; // room beside the outer wheels for assist dots
  var TC_DOT_SPACE = 0.25; // room under an engine for the traction-control dot
  var DUAL_GAP = 0.6;  // same-side wheels on one axle closer than this are a dual set
  var DUAL_GAP_M = 0.04;    // gap between tyres of a dual set when spread from one hub (m)
  var MIN_TYRE_W = 3, MIN_TYRE_L = 6;   // px; only so very small tyres stay visible

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

  // Real tyre size in metres: length (top view) = diameter, width = tyre width.
  function tyreDims(w) {
    var r = +w.rd, wd = +w.wd;
    w._len = (r > 0.1 && r < 3) ? 2 * r : TYRE_H;
    w._wd = (wd > 0.04 && wd < 2) ? wd : TYRE_W;
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
        if (cur && side !== 0 && cur.side === side && +w.x - cur.lastX < DUAL_GAP) {
          cur.wheels.push(w); cur.lastX = +w.x;
        } else {
          sets.push({ side: side, wheels: [w], lastX: +w.x });
        }
      });
      sets.forEach(function (st) {
        var k = st.wheels.length, spread = false, j;
        for (j = 1; j < k; j++) {
          var p = st.wheels[j - 1], q = st.wheels[j];
          if (+q.x - +p.x < (p._wd + q._wd) / 2) spread = true;
        }
        st.spread = spread;
        st.cx = st.wheels.reduce(function (s, w) { return s + +w.x; }, 0) / k;
        st.pitch = Math.max.apply(null, st.wheels.map(function (w) { return w._wd; })) + DUAL_GAP_M;
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
      box = { x0: Math.min(+ext.x0, tx0), x1: Math.max(+ext.x1, tx1),
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
      halfH = Math.max(halfH, Math.abs(+s.y - cy) + ENGINE_H / 2 + TC_DOT_SPACE);
    });
    return {
      cx: cx, cy: cy, box: box, hasExt: hasExt,
      boxHalfW: boxHalfW, boxHalfH: boxHalfH,
      halfW: halfW, halfH: halfH,
      axles: axles
    };
  }

  // Radius (metres, from the body centre) the circle must hold for a lone vehicle:
  // its body, every tyre at any steering angle, the assist dots and the engine.
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
      rM = Math.max(rM, Math.hypot(s.x - g.cx, s.y - g.cy) + Math.hypot(ENGINE_W, ENGINE_H) / 2 + TC_DOT_SPACE);
    });
    return rM;
  }

  // Axles, chassis spine, differentials, driveshafts and power sources (under the tyres).
  // map(x, y) converts vehicle metres to canvas pixels; s = pixels per metre.
  function drawDrivetrain(ctx, body, map, s) {
    var g = body.geo, axles = g.axles;
    var byId = {};
    body.wheels.forEach(function (w) { byId[w.i] = w; });
    ctx.save();
    ctx.lineCap = 'round';

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
    var drivenWidth = clamp(0.09 * s, 2, 4.5);

    // chassis spine, front axle to rear axle
    if (axles.length > 1) {
      var a0 = map(centreX, axles[0].y), a1 = map(centreX, axles[axles.length - 1].y);
      ctx.strokeStyle = DRIVETRAIN.spine;
      ctx.lineWidth = clamp(0.14 * s, 2, 7);
      ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.stroke();
    }

    // axles: a thin base line, then each driven half-shaft tinted by the torque going to that wheel
    axles.forEach(function (a) {
      if (a.wheels.length >= 2) {
        var l = map(a.minX, a.y), r = map(a.maxX, a.y);
        ctx.strokeStyle = DRIVETRAIN.axle;
        ctx.lineWidth = clamp(0.05 * s, 1.5, 3);
        ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
      }
      var driven = a.wheels.filter(function (w) { return !!+w.d; });
      if (!driven.length) return;
      var hubX = driven.length > 1
        ? driven.reduce(function (sum, w) { return sum + +w.x; }, 0) / driven.length : a.cx;
      var hub = map(hubX, a.y);
      driven.forEach(function (w) {
        var end = map(+w.x, a.y);
        ctx.strokeStyle = torqueColour((+w.dr || 0) * 0.7);
        ctx.lineWidth = drivenWidth;
        ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.lineTo(end.x, end.y); ctx.stroke();
      });
    });

    // driveshafts from each power source to what it drives
    var shafts = [], diffs = [];
    body.sources.forEach(function (src) {
      var ids = toArray(src.w), sx = sourceX(src);
      axles.forEach(function (a) {
        var mine = a.wheels.filter(function (w) { return ids.indexOf(w.i) !== -1; });
        if (!mine.length) return;
        var torque = mine.reduce(function (sum, w) { return sum + (+w.dr || 0); }, 0) / mine.length;
        var tx = mine.length > 1 ? mine.reduce(function (sum, w) { return sum + +w.x; }, 0) / mine.length : +mine[0].x;
        var ty = mine.length > 1 ? a.y : +mine[0].y;
        shafts.push({ from: map(sx, +src.y), to: map(tx, ty), torque: torque });
        if (mine.length > 1) diffs.push(map(tx, ty));
      });
    });
    shafts.forEach(function (sh) {
      ctx.strokeStyle = torqueColour(sh.torque * 0.7);
      ctx.lineWidth = drivenWidth;
      ctx.beginPath(); ctx.moveTo(sh.from.x, sh.from.y); ctx.lineTo(sh.to.x, sh.to.y); ctx.stroke();
    });
    diffs.forEach(function (p) {
      var d = clamp(DIFF * s, 5, 12);
      ctx.fillStyle = DRIVETRAIN.diff;
      ctx.fillRect(p.x - d / 2, p.y - d / 2, d, d);
    });

    // engines and motors, with the traction-control dot underneath when TC is intervening
    body.sources.forEach(function (src) {
      var p = map(sourceX(src), +src.y), bottom;
      ctx.setLineDash(+src.e ? [3, 2] : []);
      if (src.k === 'ev') {
        var r = clamp(MOTOR_R * s, 5, 12);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = DRIVETRAIN.engineEdge; ctx.fill();
        ctx.strokeStyle = DRIVETRAIN.motor; ctx.lineWidth = clamp(r * 0.35, 2, 4); ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = DRIVETRAIN.motor; ctx.fill();
        bottom = p.y + r;
      } else {
        var ew = clamp(ENGINE_W * s, 12, 34), eh = clamp(ENGINE_H * s, 9, 26);
        roundRect(ctx, p.x - ew / 2, p.y - eh / 2, ew, eh, Math.min(4, eh * 0.2));
        ctx.fillStyle = DRIVETRAIN.engine; ctx.fill();
        ctx.strokeStyle = DRIVETRAIN.engineEdge; ctx.lineWidth = 1.5; ctx.stroke();
        // cylinder-head ribs
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'; ctx.lineWidth = 1; ctx.setLineDash([]);
        for (var k = 1; k <= 3; k++) {
          var yy = p.y - eh / 2 + (eh * k) / 4;
          ctx.beginPath(); ctx.moveTo(p.x - ew * 0.32, yy); ctx.lineTo(p.x + ew * 0.32, yy); ctx.stroke();
        }
        bottom = p.y + eh / 2;
      }
      ctx.setLineDash([]);
      if (+body.tc) {
        var dr = clamp(0.09 * s, 2.5, 4.5);
        var cy = bottom + Math.max(3, dr) + dr + 1;
        ctx.save();
        // dark ring so it stays visible on top of a green driveshaft
        ctx.beginPath(); ctx.arc(p.x, cy, dr + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 12, 16, 0.9)'; ctx.fill();
        ctx.shadowColor = ASSIST_TC; ctx.shadowBlur = dr * 2;
        ctx.fillStyle = ASSIST_TC;
        ctx.beginPath(); ctx.arc(p.x, cy, dr, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    });

    ctx.restore();
  }

  // Driver inputs on the rim of the circle, a quarter turn each at full input:
  // steering from 12 o'clock towards 9 (left) or 3 (right); brake from 6 towards 9;
  // throttle from 6 towards 3. Nothing is drawn at rest.
  var INPUT = {
    steer:    'rgb(45, 115, 205)',
    brake:    'rgb(205, 45, 40)',
    throttle: 'rgb(60, 180, 75)'
  };
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
    ctx.lineWidth = lw; ctx.lineCap = 'butt';
    if (steer > 0) arc(INPUT.steer, TOP - steer * Q, TOP);        // left: counter-clockwise from the top
    else if (steer < 0) arc(INPUT.steer, TOP, TOP - steer * Q);   // right: clockwise from the top
    arc(INPUT.brake, BOTTOM, BOTTOM + brk * Q);                    // bottom-left quarter
    arc(INPUT.throttle, BOTTOM - thr * Q, BOTTOM);                 // bottom-right quarter
    ctx.restore();
  }

  // G-force dot: the force the driver feels (braking pushes it forward/up, a left turn
  // pushes it right). The circle's edge is GF_MAX. Recent positions are redrawn as
  // fading ghosts, like a mouse trail, so the dot leaves a path.
  var GF_MAX = 1.5;          // g at the edge of the circle (road cars peak around 1 g)
  var TRAIL_MS = 800;        // how long a ghost takes to fade out completely
  var GF_COLOUR = [242, 195, 26];

  function drawGForce(ctx, trail, cx, cy, R, gf) {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var gx = +gf.x || 0, gy = +gf.y || 0, mag = Math.hypot(gx, gy);
    if (mag > GF_MAX) { gx *= GF_MAX / mag; gy *= GF_MAX / mag; }   // pin to the edge
    // positions are stored as fractions of the radius so a resize doesn't smear the trail
    trail.push({ x: gx / GF_MAX, y: -gy / GF_MAX, t: now });
    while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();

    var dotR = clamp(R * 0.06, 3.5, 9), reach = R - dotR - 2;
    var rgb = GF_COLOUR.join(', ');
    ctx.save();
    for (var k = 0; k < trail.length - 1; k++) {        // ghosts, oldest first
      var life = 1 - (now - trail[k].t) / TRAIL_MS;
      ctx.fillStyle = 'rgba(' + rgb + ', ' + (0.5 * life * life).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(cx + trail[k].x * reach, cy + trail[k].y * reach, dotR * (0.7 + 0.3 * life), 0, Math.PI * 2);
      ctx.fill();
    }
    var head = trail[trail.length - 1];
    ctx.beginPath(); ctx.arc(cx + head.x * reach, cy + head.y * reach, dotR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(' + rgb + ')'; ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'; ctx.lineWidth = 1; ctx.stroke();
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
  // wheelPoint(w) gives a wheel's drawn centre in pixels.
  // dims(w) gives a tyre's drawn size in pixels: { w, h }.
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
        var dx = side === 'left' ? -reach : reach;
        ctx.save();
        ctx.shadowColor = best.colour; ctx.shadowBlur = r * 2;
        ctx.fillStyle = best.colour;
        ctx.beginPath(); ctx.arc(p.x + dx, p.y, r, 0, Math.PI * 2); ctx.fill();
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
        return { wheels: wheels, sources: toArray(b.sources), tc: b.tc, inp: b.inp, gf: b.gf, ext: b.ext };
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
    var inner = rPx - clamp(rPx * 0.05, 3, 7) - 2;
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
    placements.forEach(function (p) {
      var g = p.body.geo;
      p.map = function (x, y) {   // vehicle metres → canvas pixels, forward = up
        return { x: p.ox + (x - g.cx) * scale, y: p.oy - (y - g.cy) * scale };
      };
      drawDrivetrain(ctx, p.body, p.map, scale);
    });
    if (bodies[0].gf) drawGForce(ctx, trail, ccx, ccy, rPx, bodies[0].gf);

    placements.forEach(function (p) {
      var map = p.map;
      var dims = function (wh) {
        return { w: Math.max(wh._wd * scale, MIN_TYRE_W), h: Math.max(wh._len * scale, MIN_TYRE_L) };
      };
      var wheelPoint = function (wh) {
        var st = wh._set;
        if (!st.spread) return map(wh._mx, +wh.y);
        // spread sets: real pitch, but never closer than a hairline when tyres are tiny
        var widest = Math.max.apply(null, st.wheels.map(function (s) { return dims(s).w; }));
        var c = map(st.cx, +wh.y);
        return { x: c.x + wh._slot * Math.max(st.pitch * scale, widest + 1.5), y: c.y };
      };
      p.body.wheels.forEach(function (wh) {
        var pt = wheelPoint(wh), d = dims(wh);
        drawTyre(ctx, pt.x, pt.y, d.w, d.h, wh, wh._set.side < 0, opts);
      });
      drawAssistDots(ctx, p.body, wheelPoint, dims);
    });
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

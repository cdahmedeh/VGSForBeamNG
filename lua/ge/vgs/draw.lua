-- VGS Display : the game-engine renderer
-- ---------------------------------------------------------------------------
-- Draws everything that moves (tyres, shafts and differentials, the G-force dot and its trail,
-- the inputs on the rim, the direction marker, the assist dots, the balance) every game frame,
-- in a click-through ImGui window laid exactly over the app, the way BeamNG's own minimap is
-- drawn. The app works out the layout and draws what only changes with it (the circle, the
-- outlines, the hitches); it hands over a scene in its own pixels (see sceneOf in app.js), and
-- this draws it with each vehicle's latest update, as the vehicles send them to vgsHub.
--
-- It's a straight port of the app's canvas renderer (app.js), with the same constants, so the
-- two look the same; app.js stays the reference and the fallback.
--
-- All drawing goes through a small set of primitives (gfx, below), in the app's pixels: the
-- ImGui one maps them onto the screen; the tests swap in one that records them.
-- ---------------------------------------------------------------------------

local M = {}

local abs, min, max, floor, sqrt, sin, cos, atan2, log, exp, pi =
  math.abs, math.min, math.max, math.floor, math.sqrt, math.sin, math.cos, math.atan2, math.log, math.exp, math.pi
local band, rshift = bit.band, bit.rshift
local HUGE = math.huge

local function clamp(v, lo, hi) if v < lo then return lo elseif v > hi then return hi end return v end
local function num(v, d) v = tonumber(v); if v == nil or v ~= v then return d or 0 end return v end
local function on(v) return v ~= nil and v ~= false and v ~= 0 and v ~= "0" end

-- ===== Colours (as in app.js) =================================================
-- { r, g, b, a } with r, g, b 0..255 and a 0..1
local function rgba(r, g, b, a) return { r, g, b, a or 1 } end
local STYLE = {
  neutral = { 128, 134, 145 }, drive = { 70, 225, 95 }, brake = { 255, 60, 50 },
  gripFill = rgba(236, 240, 246, 0.92),
  tyreBg = rgba(0, 0, 0, 0.5),
  broken = rgba(160, 160, 160, 0.6),
  airborne = rgba(40, 130, 235),
  airLight = { 120, 178, 245 },
  text = rgba(255, 255, 255, 0.88),
}
local DRIVETRAIN = {
  axle = rgba(255, 255, 255, 0.22),
  diffBg = rgba(22, 25, 31),
  gearbox = rgba(200, 205, 214, 0.88),
  diff = rgba(236, 240, 246, 0.75),
  engine = rgba(236, 240, 246, 0.88),
  engineEdge = rgba(0, 0, 0, 0.55),
  motor = rgba(236, 240, 246, 0.88),
}
local ASSIST = {
  [1] = { c = rgba(255, 85, 75, 0.9), rank = 1 },
  [2] = { c = rgba(80, 220, 120, 0.9), rank = 1.5 },
  [3] = { c = rgba(95, 165, 255, 0.9), rank = 2 },
}
local INPUT = {
  steer = { 45, 115, 205 }, brake = { 205, 45, 40 }, throttle = { 60, 180, 75 },
  brakePulse = { 240, 80, 70 }, throttlePulse = { 30, 110, 45 },
  clutch = { 225, 229, 236 }, handbrake = { 135, 22, 58 },
}
local TRAVEL_COLOUR = {
  neutral = { 150, 210, 245 }, near = { 255, 214, 10 }, rnear = { 255, 214, 10 }, limit = { 255, 214, 10 },
  under = { 255, 96, 24 }, over = { 250, 130, 235 }, drift = { 60, 230, 195 }, pslide = { 60, 230, 195 },
}
local GF_COLOUR = { 240, 215, 130 }

local function mixRgb(a, b, t)
  return { floor(a[1] + (b[1] - a[1]) * t + 0.5), floor(a[2] + (b[2] - a[2]) * t + 0.5), floor(a[3] + (b[3] - a[3]) * t + 0.5), 1 }
end
local function torqueColour(t)
  t = clamp(num(t), -1, 1)
  if t >= 0 then return mixRgb(STYLE.neutral, STYLE.drive, t) end
  return mixRgb(STYLE.neutral, STYLE.brake, -t)
end
-- sliding fill: greyish red the moment grip breaks, deepening to saturated red (hsl, as app.js)
local SLIDE_LOW, SLIDE_HIGH = { 3, 48, 64 }, { 0, 100, 47 }
local function hsl(h, s, l)
  h, s, l = (h % 360) / 360, s / 100, l / 100
  local function hue(p, q, t)
    if t < 0 then t = t + 1 elseif t > 1 then t = t - 1 end
    if t < 1 / 6 then return p + (q - p) * 6 * t end
    if t < 1 / 2 then return q end
    if t < 2 / 3 then return p + (q - p) * (2 / 3 - t) * 6 end
    return p
  end
  if s == 0 then return { l * 255, l * 255, l * 255, 1 } end
  local q = l < 0.5 and l * (1 + s) or l + s - l * s
  local p = 2 * l - q
  return { hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255, 1 }
end
local function slideColour(sev)
  local k = clamp(sev == nil and 1 or num(sev), 0, 1)
  return hsl(SLIDE_LOW[1] + (SLIDE_HIGH[1] - SLIDE_LOW[1]) * k, SLIDE_LOW[2] + (SLIDE_HIGH[2] - SLIDE_LOW[2]) * k,
    SLIDE_LOW[3] + (SLIDE_HIGH[3] - SLIDE_LOW[3]) * k)
end
local function withAlpha(c, a) return { c[1], c[2], c[3], (c[4] or 1) * a } end

-- ===== Primitives ===========================================================
-- gfx: { fill(pts, n, col) convex polygon; stroke(pts, n, col, w, closed); circleFill(x, y, r, col);
-- circle(x, y, r, col, w); arc(x, y, r, a0, a1, col, w); cap(x, y, r, a, col);
-- textCentered(cx, baseline, px, col, s, bold) }
-- pts: flat { x1, y1, x2, y2, ... }, in the app's pixels.
local P = {}   -- scratch point list
local function rectPts(x0, y0, x1, y1)
  P[1], P[2], P[3], P[4], P[5], P[6], P[7], P[8] = x0, y0, x1, y0, x1, y1, x0, y1
  return P, 4
end
-- the rounded rectangle app.js draws (quadratic corners), as a polygon
local RR = {}
local function roundRectPts(x, y, w, h, r)
  r = max(0, min(r, w / 2, h / 2))
  local n = 0
  local function add(px, py) RR[n * 2 + 1], RR[n * 2 + 2] = px, py; n = n + 1 end
  local function corner(ax, ay, cx, cy, bx, by)   -- quadratic from a to b around control c
    for i = 0, 4 do
      local t = i / 4
      local u = 1 - t
      add(u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by)
    end
  end
  if r <= 0 then add(x, y); add(x + w, y); add(x + w, y + h); add(x, y + h); return RR, n end
  corner(x + w - r, y, x + w, y, x + w, y + r)
  corner(x + w, y + h - r, x + w, y + h, x + w - r, y + h)
  corner(x + r, y + h, x, y + h, x, y + h - r)
  corner(x, y + r, x, y, x + r, y)
  return RR, n
end
-- a dashed stroke along a polyline: dash, gap (px), the pattern starting at the first point
local DSEG = {}
local function dashStroke(g, pts, n, closed, col, w, dash, gap)
  local total = closed and n or n - 1
  local drawing = true
  local left = dash
  for s = 1, total do
    local i1, i2 = s, (s % n) + 1
    local ax, ay, bx, by = pts[i1 * 2 - 1], pts[i1 * 2], pts[i2 * 2 - 1], pts[i2 * 2]
    local len = sqrt((bx - ax) ^ 2 + (by - ay) ^ 2)
    local pos = 0
    while pos < len - 1e-6 do
      local step = min(left, len - pos)
      if drawing then
        local t0, t1 = pos / len, (pos + step) / len
        DSEG[1], DSEG[2] = ax + (bx - ax) * t0, ay + (by - ay) * t0
        DSEG[3], DSEG[4] = ax + (bx - ax) * t1, ay + (by - ay) * t1
        g.stroke(DSEG, 2, col, w, false)
      end
      pos = pos + step
      left = left - step
      if left <= 1e-6 then drawing = not drawing; left = drawing and dash or gap end
    end
  end
end

-- ===== Steering scale (as app.js) ============================================
local STEER_EXPAND, STEER_TARGET, STEER_K_MAX = 20, 0.6, 400
local STEER_HIDE_DEG, STEER_SHOW_DEG, STEER_VIS_K = 8 / 3, 6, 60
local function asinhNorm(x, k)
  return log(k * x + sqrt(k * k * x * x + 1)) / log(k + sqrt(k * k + 1))
end
local function steerK(ref)
  local k0 = STEER_EXPAND
  if not (ref and ref > 0) or ref >= 1 then return k0 end
  if asinhNorm(ref, k0) >= STEER_TARGET then return k0 end
  local lo, hi = log(max(k0, 1)), log(STEER_K_MAX)
  if asinhNorm(ref, STEER_K_MAX) <= STEER_TARGET then return STEER_K_MAX end
  for _ = 1, 30 do
    local mid = (lo + hi) / 2
    if asinhNorm(ref, exp(mid)) < STEER_TARGET then lo = mid else hi = mid end
  end
  return exp((lo + hi) / 2)
end
local function steerScale(x, k)
  k = k or STEER_EXPAND
  local a = abs(x)
  if not (k > 0) or a >= 1 then return x end
  return (x < 0 and -1 or 1) * asinhNorm(a, k)
end
local function markerSize(r) return clamp(r * 0.1, 8, 16) end

-- ===== The balance state and the marker (as app.js) ===========================
local UNDER_WARN, NEUTRAL_UNDER, NEUTRAL_OVER, STATE_EDGE = 0.35, -0.04, 0.15, 0.03
local DRIFT_ON, DRIFT_OFF, DRIFT_CONFIRM_MS = 0.6, 0.45, 200
local STATE_HOLD_MS, STATE_BLEND_MS, MARK_FADE_IN_MS, MARK_FADE_OUT_MS = 450, 80, 30, 120
local STATE_SEVERITY = { near = 1, rnear = 1, limit = 2, under = 3, over = 3, drift = 3, pslide = 3 }
local BS_STATE = { [1] = 'near', [2] = 'under', [3] = 'rnear', [4] = 'limit', [5] = 'over', [6] = 'pslide' }
local function balanceState(bal, dc, cur, bs)
  if bs ~= nil then
    local st = BS_STATE[num(bs)]
    if st == 'over' then return num(dc) >= (cur == 'drift' and DRIFT_OFF or DRIFT_ON) and 'drift' or 'over' end
    return st
  end
  bal = tonumber(bal)
  if bal == nil or bal ~= bal or abs(bal) == HUGE then return nil end
  dc = num(dc)
  local underSide, overSide = cur == 'under' or cur == 'near', cur == 'over' or cur == 'drift'
  if bal <= -UNDER_WARN + (cur == 'under' and STATE_EDGE * 1.5 or 0) then return 'under' end
  if bal <= NEUTRAL_UNDER + (underSide and STATE_EDGE or 0) then return 'near' end
  if bal >= NEUTRAL_OVER - (overSide and STATE_EDGE or 0) then return dc >= (cur == 'drift' and DRIFT_OFF or DRIFT_ON) and 'drift' or 'over' end
  return nil
end
local function stateRgb(st) return TRAVEL_COLOUR[st] or TRAVEL_COLOUR.neutral end

-- The marker's state for this frame: which state shows, after the hold, its colour (blended
-- briefly when it changes) and how much of it shows (fading in and out at neutral).
local function markerState(view, inp, now)
  local bal, dc, bs = inp and inp.bal, inp and inp.dc, inp and inp.bs
  local m = view.mark
  if not m then
    local s0 = balanceState(bal, dc, nil, bs)
    local c = stateRgb(s0)
    m = { cur = s0, cand = s0, candT = -HUGE, since = now, t = now, a = s0 and 1 or 0,
          rgb = { c[1], c[2], c[3] }, from = { c[1], c[2], c[3] }, t0 = -HUGE }
    view.mark = m
  end
  local dt = clamp(now - m.t, 0, 100); m.t = now
  local cand, cur = balanceState(bal, dc, m.cur, bs), m.cur
  if cand ~= m.cand then m.cand = cand; m.candT = now end
  if (cand == 'drift' or cand == 'pslide') and cur ~= cand and now - m.candT < DRIFT_CONFIRM_MS then cand = 'over' end
  if cand == cur then m.since = now
  else
    local at = cand and (not cur or STATE_SEVERITY[cand] > STATE_SEVERITY[cur] or (STATE_SEVERITY[cand] == 3 and STATE_SEVERITY[cur] == 3))
    if at or now - m.since >= STATE_HOLD_MS then
      if cand then m.from = { m.rgb[1], m.rgb[2], m.rgb[3] }; m.t0 = cur and now or -HUGE end
      m.cur = cand; m.since = now
    end
  end
  if m.cur then
    local to, k = stateRgb(m.cur), clamp((now - m.t0) / STATE_BLEND_MS, 0, 1)
    for c = 1, 3 do m.rgb[c] = m.from[c] + (to[c] - m.from[c]) * k end
  end
  local target = m.cur and 1 or 0
  m.a = m.a + (target - m.a) * (1 - exp(-dt / (target > m.a and MARK_FADE_IN_MS or MARK_FADE_OUT_MS)))
  if m.a < 0.01 then m.a = 0 end
  return m
end

-- ===== Readouts: the balance's degrees, averaged so they can be read =============
local READ_MS = 150
local function readAdd(R, key, v)
  if v == nil or v ~= v or abs(v) == HUGE then return end
  local a = R.acc[key]
  if not a then a = { s = 0, n = 0 }; R.acc[key] = a end
  a.s, a.n = a.s + v, a.n + 1
  if R.val[key] == nil then R.val[key] = v end
end
local function readTick(R, now)
  if now - R.t0 < READ_MS then return end
  R.t0 = now
  for k, a in pairs(R.acc) do
    if a.n > 0 then R.val[k] = a.s / a.n; a.s, a.n = 0, 0
    else R.val[k] = nil; R.acc[k] = nil end
  end
end
local function readGet(R, key, fallback)
  local v = R.val[key]
  if v == nil then return fallback end
  return v
end

-- ===== Rim: inputs and the direction marker ======================================
local PULSE_HZ = 5
local function drawInputArcs(g, sc, inp, mk, now)
  local cx, cy, rPx = sc.cx, sc.cy, sc.r
  local lw = clamp(rPx * 0.05, 3, 7)
  local r, Q = rPx - lw / 2, pi / 2
  local TOP, BOTTOM = -Q, Q
  local steer, thr, brk = clamp(num(inp.s), -1, 1), clamp(num(inp.t), 0, 1), clamp(num(inp.b), 0, 1)
  local function arc(col, from, to, rr, w)
    if to - from < 0.004 then return end
    g.arc(cx, cy, rr, from, to, col, w)
  end
  local hasTravel = inp.tv ~= nil
  local tv = hasTravel and clamp(num(inp.tv), -4, 4) or 0
  local alpha = clamp(inp.ta == nil and 1 or num(inp.ta), 0, 1) * mk.a
  local sk = num(inp.k) > 0 and num(inp.k) or steerK(tonumber(inp.sr))
  local steerShown = steerScale(steer, sk)
  local steerDeg = steerScale(abs(steer), min(sk, STEER_VIS_K)) * 90
  local steerVis = clamp((steerDeg - STEER_HIDE_DEG) / (STEER_SHOW_DEG - STEER_HIDE_DEG), 0, 1)
  steerVis = steerVis * steerVis * (3 - 2 * steerVis)
  if steerVis > 0 then
    local c = { INPUT.steer[1], INPUT.steer[2], INPUT.steer[3], steerVis }
    if steerShown > 0 then arc(c, TOP - steerShown * Q, TOP, r, lw) else arc(c, TOP, TOP - steerShown * Q, r, lw) end
  end
  local pulse = 0.5 + 0.5 * sin(now / 1000 * 2 * pi * PULSE_HZ)
  arc(on(inp.abs) and mixRgb(INPUT.brake, INPUT.brakePulse, pulse) or INPUT.brake, BOTTOM, BOTTOM + brk * Q, r, lw)
  arc(on(inp.tcs) and mixRgb(INPUT.throttle, INPUT.throttlePulse, pulse) or INPUT.throttle, BOTTOM - thr * Q, BOTTOM, r, lw)
  local clu, hb = clamp(num(inp.c), 0, 1), clamp(num(inp.p), 0, 1)
  arc(INPUT.handbrake, BOTTOM, BOTTOM + hb * Q, rPx - lw / 4, lw / 2)
  arc(INPUT.clutch, BOTTOM - clu * Q, BOTTOM, rPx - lw / 4, lw / 2)
  if hasTravel and alpha > 0 then
    local ang = TOP - steerScale(tv, sk) * Q
    local mh = markerSize(rPx)
    local tip = rPx - lw - 0.5
    local base, half = tip - mh, mh * 0.55
    local ux, uy = cos(ang), sin(ang)
    local px, py = -uy, ux
    local steerAng = TOP - steerShown * Q
    local gap = ang - steerAng
    if abs(gap) > 0.03 and abs(gap) < pi then
      local bw = clamp(lw * 0.6, 2, 4.5)
      local rr = tip - bw / 2 - 0.5
      local a0, a1 = min(ang, steerAng), max(ang, steerAng)
      local col = { mk.rgb[1], mk.rgb[2], mk.rgb[3], 0.7 * alpha }
      g.arc(cx, cy, rr, a0, a1, col, bw)
      -- round ends
      g.cap(cx + cos(a0) * rr, cy + sin(a0) * rr, bw / 2, a0 + pi / 2, col)
      g.cap(cx + cos(a1) * rr, cy + sin(a1) * rr, bw / 2, a1 - pi / 2, col)
    end
    P[1], P[2] = cx + ux * tip, cy + uy * tip
    P[3], P[4] = cx + ux * base + px * half, cy + uy * base + py * half
    P[5], P[6] = cx + ux * base - px * half, cy + uy * base - py * half
    g.fill(P, 3, { mk.rgb[1], mk.rgb[2], mk.rgb[3], alpha })
    g.stroke(P, 3, { 8, 10, 14, 0.85 * alpha }, 1.5, true)
  end
end

-- ===== The G-force dot and its trail ============================================
local GF_MAX, TRAIL_MS, TRAIL_STEP_MS = 1.5, 1300, 12
local function drawGForce(g, view, sc, gf, now)
  local trail = view.trail
  local gx, gy = num(gf.x), num(gf.y)
  local mag = sqrt(gx * gx + gy * gy)
  if mag > GF_MAX then gx, gy = gx * GF_MAX / mag, gy * GF_MAX / mag end
  local last = trail[#trail]
  if last and now - last.t < TRAIL_STEP_MS then last.x, last.y = gx / GF_MAX, -gy / GF_MAX
  else trail[#trail + 1] = { x = gx / GF_MAX, y = -gy / GF_MAX, t = now } end
  while trail[1] and now - trail[1].t > TRAIL_MS do table.remove(trail, 1) end
  local R, cx, cy = sc.r, sc.cx, sc.cy
  local dotR = clamp(R * 0.058, 3.5, 8.5)
  local reach = R - dotR - 2
  local head = trail[#trail]
  local minStep, lastX, lastY = dotR * 0.6 / reach, HUGE, HUGE
  for k = 1, #trail - 1 do
    local tk = trail[k]
    if sqrt((tk.x - head.x) ^ 2 + (tk.y - head.y) ^ 2) >= dotR / reach
       and sqrt((tk.x - lastX) ^ 2 + (tk.y - lastY) ^ 2) >= minStep then
      lastX, lastY = tk.x, tk.y
      local life = 1 - (now - tk.t) / TRAIL_MS
      g.circleFill(cx + tk.x * reach, cy + tk.y * reach, dotR * (0.7 + 0.3 * life),
        { GF_COLOUR[1], GF_COLOUR[2], GF_COLOUR[3], 0.42 * life * life })
    end
  end
  local hx, hy = cx + head.x * reach, cy + head.y * reach
  g.circle(hx, hy, dotR + 1.2, { 8, 10, 14, 0.55 }, 1.5)
  g.circleFill(hx, hy, dotR, { GF_COLOUR[1], GF_COLOUR[2], GF_COLOUR[3], 0.68 })
  g.circle(hx, hy, dotR, { GF_COLOUR[1], GF_COLOUR[2], GF_COLOUR[3], 0.95 }, 1.25)
end

-- ===== Drivetrain ===============================================================
local function tyreReach(t, s)
  -- how far a (possibly steered) tyre reaches from its centre across (hx) and along (hy)
  local c, sn = abs(cos(s)), abs(sin(s))
  local hx = min(c > 1e-6 and t[4] / 2 / c or HUGE, sn > 1e-6 and t[5] / 2 / sn or HUGE)
  local hy = min(c > 1e-6 and t[5] / 2 / c or HUGE, sn > 1e-6 and t[4] / 2 / sn or HUGE)
  return hx, hy
end

local SH, ENDS = {}, {}
local RIB, TC_EDGE, GB_GATE = { 0, 0, 0, 0.35 }, { 10, 12, 16, 0.75 }, { 0, 0, 0, 0.6 }
local function drawDrivetrain(g, b, live, alphaAll)
  local sz, dg, byI = b.sz, live.dg or {}, live.__byI
  -- node states from the packed live codes (see updateGraph in vgsTelemetry.lua)
  local par, dead = b.par or {}, {}
  for k = 1, #par do
    local code = num(dg[k])
    dead[k] = band(rshift(code, 2), 1) == 1 or (par[k] >= 0 and dead[par[k] + 1]) or false
  end
  for si, sh in ipairs(b.sh or {}) do
    local sum, n = 0, 0
    for _, i in ipairs(sh.ws or {}) do
      local w = byI[i]
      if w then sum = sum + num(w.dr); n = n + 1 end
    end
    local torque = n > 0 and sum / n or 0
    local p, np = sh.p, #sh.p / 2
    for q = 1, #p do SH[q] = p[q] end
    local we = sh.we
    if we then   -- the end at the tyre follows its steering
      local own = b.t[we.own + 1]
      if own then
        local fx, fy = SH[np * 2 - 3], SH[np * 2 - 2]
        local ow = byI[own[1]]
        local ohx, ohy = tyreReach(own, ow and num(ow.s) or 0)
        if we.ax == 0 then
          local toRight = fx < own[2]
          local ex = toRight and HUGE or -HUGE
          for _, ti in ipairs(we.set or {}) do
            local t = b.t[ti + 1]
            if t then
              local tw = byI[t[1]]
              local hx = tyreReach(t, tw and num(tw.s) or 0)
              if toRight then ex = min(ex, t[2] - hx) else ex = max(ex, t[2] + hx) end
            end
          end
          if abs(ex) ~= HUGE then
            if (toRight and ex < fx) or (not toRight and ex > fx) then ex = fx end
            SH[np * 2 - 1] = ex
          end
        else
          local down = fy < own[3]
          local ey = own[3] + (down and -ohy or ohy)
          if (down and ey < fy) or (not down and ey > fy) then ey = fy end
          SH[np * 2] = ey
        end
      end
    end
    local e = ENDS[si] or {}
    ENDS[si] = e
    e.x, e.y = SH[np * 2 - 1], SH[np * 2]
    local dx, dy = e.x - SH[np * 2 - 3], e.y - SH[np * 2 - 2]
    local dl = sqrt(dx * dx + dy * dy)
    e.ux, e.uy, e.ok = (dl > 1e-6) and dx / dl or 0, (dl > 1e-6) and dy / dl or 0, dl > 1e-6
    if dead[sh.n + 1] then
      dashStroke(g, SH, np, false, withAlpha(DRIVETRAIN.axle, alphaAll), max(1.5, sz.dw * 0.7), 3, 3)
    else
      g.stroke(SH, np, withAlpha(torqueColour(torque * 0.7), alphaAll), sz.dw, false)
    end
  end
  local srcs = live.src or {}
  for _, pt in ipairs(b.pa or {}) do
    local x, y = pt.x, pt.y
    if pt.k == 'eng' then
      local ew, eh = sz.ew, sz.eh
      local pts, n = roundRectPts(x - ew / 2, y - eh / 2, ew, eh, min(4, eh * 0.2))
      g.fill(pts, n, DRIVETRAIN.engine)
      if on(pt.dash) then dashStroke(g, pts, n, true, DRIVETRAIN.engineEdge, 1.5, 3, 2)
      else g.stroke(pts, n, DRIVETRAIN.engineEdge, 1.5, true) end
      for k = 1, 3 do
        local yy = y - eh / 2 + (eh * k) / 4
        P[1], P[2], P[3], P[4] = x - ew * 0.32, yy, x + ew * 0.32, yy
        g.stroke(P, 2, RIB, 1, false)
      end
    elseif pt.k == 'mot' then
      local r = sz.mr
      g.circleFill(x, y, r, DRIVETRAIN.engineEdge)
      if on(pt.dash) then   -- dashed 3, 2 like the canvas
        local n = max(4, floor(2 * pi * r / 5))
        for i = 0, n - 1 do
          local a0 = i / n * 2 * pi
          g.arc(x, y, r, a0, a0 + 0.6 * 2 * pi / n, DRIVETRAIN.motor, clamp(r * 0.3, 1.2, 2))
        end
      else
        g.circle(x, y, r, DRIVETRAIN.motor, clamp(r * 0.3, 1.2, 2))
      end
      g.circleFill(x, y, r * 0.3, DRIVETRAIN.motor)
    elseif pt.k == 'gb' then
      local s = sz.gb
      local pts, n = roundRectPts(x - s / 2, y - s / 2, s, s, min(3, s * 0.2))
      g.fill(pts, n, DRIVETRAIN.gearbox)
      g.stroke(pts, n, DRIVETRAIN.engineEdge, 1.2, true)
      local gg, w = s * 0.24, max(1, s * 0.09)
      local col = GB_GATE
      -- the shift gate's H (round ends, as the canvas draws it)
      P[1], P[2], P[3], P[4] = x - gg, y - gg, x - gg, y + gg; g.stroke(P, 2, col, w, false)
      P[1], P[2], P[3], P[4] = x + gg, y - gg, x + gg, y + gg; g.stroke(P, 2, col, w, false)
      P[1], P[2], P[3], P[4] = x - gg, y, x + gg, y; g.stroke(P, 2, col, w, false)
      for _, e in ipairs({ { x - gg, y - gg }, { x - gg, y + gg }, { x + gg, y - gg }, { x + gg, y + gg } }) do
        g.circleFill(e[1], e[2], w / 2, col)
      end
    elseif pt.k == 'diff' then
      local d = sz.diff
      local code = num(dg[(pt.n or 0) + 1])
      local stc = band(code, 3)
      local a = dead[(pt.n or 0) + 1] and 0.5 or 1
      local x0, y0 = x - d / 2, y - d / 2
      if stc == 3 then
        g.fill(rectPts(x0, y0, x0 + d, y0 + d), 4, withAlpha(DRIVETRAIN.diff, a))
        g.stroke(rectPts(x0 + 0.5, y0 + 0.5, x0 + d - 0.5, y0 + d - 0.5), 4, withAlpha(DRIVETRAIN.engineEdge, a), 1, true)
      else
        local lw = clamp(d * 0.16, 1.2, 2)
        g.fill(rectPts(x0, y0, x0 + d, y0 + d), 4, withAlpha(DRIVETRAIN.diffBg, a))
        g.stroke(rectPts(x0 + lw / 2, y0 + lw / 2, x0 + d - lw / 2, y0 + d - lw / 2), 4, withAlpha(DRIVETRAIN.diff, a), lw, true)
        if stc == 2 then
          local c = max(2, d * 0.34)
          g.fill(rectPts(x - c / 2, y - c / 2, x + c / 2, y + c / 2), 4, withAlpha(DRIVETRAIN.diff, a))
        end
      end
    end
  end
  -- disconnect diamonds
  for _, m in ipairs(b.mk or {}) do
    local code = num(dg[(m.n or 0) + 1])
    local open = band(rshift(code, 3 + (m.j or 0)), 1) == 1
    local ux, uy, mx, my = m.ux, m.uy, m.x, m.y
    local e = m.hub and ENDS[m.hub + 1]
    if e and e.ok then   -- a locking hub: just inside its tyre, as steered now
      ux, uy = e.ux, e.uy
      mx, my = e.x - ux * num(m.back), e.y - uy * num(m.back)
    end
    local nx, ny, r = -uy, ux, sz.cp / 2 * 1.05
    P[1], P[2] = mx + ux * r, my + uy * r
    P[3], P[4] = mx + nx * r, my + ny * r
    P[5], P[6] = mx - ux * r, my - uy * r
    P[7], P[8] = mx - nx * r, my - ny * r
    g.fill(P, 4, open and DRIVETRAIN.diffBg or DRIVETRAIN.diff)
    g.stroke(P, 4, DRIVETRAIN.diff, 1.2, true)
  end
  -- traction-control dots on top
  for _, d in ipairs(b.tc or {}) do
    local s = srcs[(d.si or 0) + 1]
    if type(s) == "table" and on(s.tc) then
      g.circleFill(d.x, d.y, d.r, ASSIST[2].c)
      g.circle(d.x, d.y, d.r, TC_EDGE, 0.8)
    end
  end
end

-- ===== Tyres and assist dots =======================================================
local function drawTyre(g, t, wh)
  local x, y, w, h = t[2], t[3], t[4], t[5]
  local broken, sliding = on(wh.b), on(wh.e)
  local flat, airborne = not broken and on(wh.fl), not broken and on(wh.a)
  local grip = clamp(num(wh.g), 0, 1)
  local lw = clamp(w * 0.16, 1, 3.5)
  local th = -num(wh.s)
  local c, s = cos(th), sin(th)
  local function rr(x0, y0, x1, y1)   -- rectangle in the tyre's own frame, onto the screen
    P[1], P[2] = x + x0 * c - y0 * s, y + x0 * s + y0 * c
    P[3], P[4] = x + x1 * c - y0 * s, y + x1 * s + y0 * c
    P[5], P[6] = x + x1 * c - y1 * s, y + x1 * s + y1 * c
    P[7], P[8] = x + x0 * c - y1 * s, y + x0 * s + y1 * c
    return P, 4
  end
  g.fill(rr(-w / 2, -h / 2, w / 2, h / 2), 4, STYLE.tyreBg)
  if not broken then
    local inset = w > 8 and 2 or 1
    local iw, ih = w - lw * 2 - inset, h - lw * 2 - inset
    if iw > 0 and ih > 0 then
      local fh = (sliding or airborne) and ih or ih * grip
      local col = airborne and STYLE.airborne or (sliding and slideColour(wh.ex) or STYLE.gripFill)
      if fh > 0 then g.fill(rr(-iw / 2, -fh / 2, iw / 2, fh / 2), 4, col) end
      local lf = airborne and 0 or clamp(num(wh.lf), 0, 1)
      if lf > 0 then
        g.fill(rr(-iw / 2, -ih / 2, iw / 2, ih / 2), 4, { STYLE.airLight[1], STYLE.airLight[2], STYLE.airLight[3], lf * lf * (3 - 2 * lf) })
      end
    end
  end
  local col = broken and STYLE.broken or torqueColour(wh.t)
  local pts = rr(-w / 2 + lw / 2, -h / 2 + lw / 2, w / 2 - lw / 2, h / 2 - lw / 2)
  if broken then dashStroke(g, pts, 4, true, col, lw, 3, 3)
  elseif flat then dashStroke(g, pts, 4, true, col, lw, max(2, h * 0.12), max(1.5, h * 0.08))
  else g.stroke(pts, 4, col, lw, true) end
end

local NO_WHEEL = {}
local function drawAssistDots(g, b, byI)
  for _, grp in ipairs(b.g or {}) do
    local best
    for _, ti in ipairs(grp.t) do
      local t = b.t[ti + 1]
      local w = t and byI[t[1]]
      local info = w and ASSIST[num(w.iv)]
      if info and (not best or info.rank > best.rank) then best = info end
    end
    if best then
      local outer
      for _, ti in ipairs(grp.t) do
        local t = b.t[ti + 1]
        if t and (not outer or (grp.s < 0 and t[2] < outer[2]) or (grp.s >= 0 and t[2] > outer[2])) then outer = t end
      end
      if outer then
        local w = byI[outer[1]] or NO_WHEEL
        local r = clamp(outer[4] * 0.22, 1.8, 3.2)
        local gap = max(3, r)
        local reach = outer[4] / 2 + abs(sin(num(w.s))) * outer[5] / 2 + gap + r
        g.circleFill(outer[2] + (grp.s < 0 and -reach or reach), outer[3], r, best.c)
      end
    end
  end
end

-- ===== The balance at the top of the circle ======================================
local STATE_WORD = { near = 'Front near limit', rnear = 'Rear near limit', limit = 'At the limit', under = 'Understeer',
  over = 'Oversteer', drift = 'Drift', pslide = 'Powerslide' }
local SHORT_WORD = { ['Understeer'] = 'Under', ['Front near limit'] = 'Front near', ['Rear near limit'] = 'Rear near',
  ['At the limit'] = 'At limit', ['Oversteer'] = 'Over', ['Drift'] = 'Drift', ['Powerslide'] = 'Powerslide' }
local function drawBalance(g, view, sc, lead, mk)
  local inp, vd = lead.inp or {}, lead.vd or {}
  if inp.bal == nil then return end
  local st = mk.cur
  if not st then return end   -- nothing to say while the car is balanced
  local word = STATE_WORD[st]
  local colour = { mk.rgb[1], mk.rgb[2], mk.rgb[3], 1 }
  local R, id = view.read, tostring(sc.lead)
  local diff
  if vd.af ~= nil and vd.ar ~= nil then diff = readGet(R, id .. ':bal', (num(vd.af) - num(vd.ar)) * 180 / pi) end
  if st == 'pslide' and vd.sl ~= nil then diff = readGet(R, id .. ':sl', num(vd.sl) * 180 / pi) end
  if st == 'drift' and vd.da ~= nil then diff = readGet(R, id .. ':da', num(vd.da)) end
  if sc.compact == 1 then word = SHORT_WORD[word] or word end
  local L = sc.bal or {}
  local fs, dfs, drop, h1 = num(L.fs, 10), num(L.dfs, 11.5), num(L.drop, 10), num(L.h1, 11.5)
  local top = sc.cy - sc.inner + drop
  -- the two baselines (an older app sends only h1)
  local b1, b2 = num(L.b1, dfs * 0.9), num(L.b2, h1 + fs)
  -- how wide the app draws each, in its own font: the text is drawn to the same width
  local ww, cw = type(L.ww) == "table" and L.ww or {}, type(L.cw) == "table" and L.cw or nil
  if diff ~= nil then
    local digits = string.format('%.1f', abs(diff))
    local deg, w = digits .. '\194\176', nil
    if cw then
      w = num(cw['\194\176'])
      for ch in digits:gmatch('.') do w = w + num(cw[ch]) end
    end
    g.textCentered(sc.cx, top + b1, dfs, colour, deg, true, w)
  end
  g.textCentered(sc.cx, top + b2, fs, colour, word, true, tonumber(ww[word]))
end

-- ===== One view (one app on screen) ===============================================
function M.newView()
  return { trail = {}, read = { acc = {}, val = {}, t0 = 0 }, mark = nil, leadId = nil, seen = {} }
end

local function liveOf(live, id)
  local p = live[id]
  if type(p) ~= "table" then return nil end
  if not p.__byI then
    local m = {}
    for _, w in ipairs(p.w or {}) do if type(w) == "table" and w.i ~= nil and m[w.i] == nil then m[w.i] = w end end
    p.__byI = m
  end
  return p
end

-- Feed the readouts with any update not seen yet (each update counts once, however many frames
-- it's drawn in).
local function feed(view, sc, live, now)
  local id = sc.lead
  local p = live[id]
  if type(p) ~= "table" or view.seen[id] == p then return end
  view.seen[id] = p
  local vd, R = p.vd, view.read
  if type(vd) == "table" then
    if vd.af ~= nil and vd.ar ~= nil then readAdd(R, tostring(id) .. ':bal', (num(vd.af) - num(vd.ar)) * 180 / pi) end
    if vd.sl ~= nil then readAdd(R, tostring(id) .. ':sl', num(vd.sl) * 180 / pi) end
    if vd.da ~= nil then readAdd(R, tostring(id) .. ':da', num(vd.da)) end
    readTick(R, now)
  end
end

-- Draw one view: g the primitives, sc the scene from the app, live[id] each vehicle's latest
-- update, now a real-time clock in ms.
function M.draw(g, view, sc, live, now)
  if type(sc) ~= "table" or type(sc.b) ~= "table" or #sc.b == 0 then
    view.trail, view.leadId, view.mark = {}, nil, nil
    return
  end
  local lead = liveOf(live, sc.lead)
  if not lead then return end
  if view.leadId ~= sc.lead then view.trail, view.mark = {}, nil end
  view.leadId = sc.lead
  feed(view, sc, live, now)
  local inp = type(lead.inp) == "table" and lead.inp or nil
  local mk = markerState(view, inp, now)
  if inp then drawInputArcs(g, sc, inp, mk, now) end
  local bodies = {}
  for k, b in ipairs(sc.b) do bodies[k] = liveOf(live, b.id) end
  for k, b in ipairs(sc.b) do
    if bodies[k] then drawDrivetrain(g, b, bodies[k], 1) end
  end
  if type(lead.gf) == "table" then drawGForce(g, view, sc, lead.gf, now) else view.trail = {} end
  for k, b in ipairs(sc.b) do
    local p = bodies[k]
    local byI = p and p.__byI or {}
    for _, t in ipairs(b.t or {}) do drawTyre(g, t, byI[t[1]] or NO_WHEEL) end
    drawAssistDots(g, b, byI)
  end
  drawBalance(g, view, sc, lead, mk)
end

-- exposed for the tests
M._balanceState, M._steerScale, M._steerK, M._torqueColour, M._slideColour = balanceState, steerScale, steerK, torqueColour, slideColour

-- ===== The ImGui primitives =========================================================
-- Map the app's pixels onto the screen: x' = ox + x * k. Colours become ImGui's packed ABGR.
-- Vectors are reused (setting .x/.y), so a frame allocates next to nothing.
local TEXT_BASELINE = 1.04   -- the game's ImGui font: baseline below the line's top, per px of text size
local SOFT_PER_STRETCH, SOFT_MAX = 2.7, 1.1   -- device px of softening per unit of UI stretch, and the most
function M.imguiGfx(im)
  local g = {}
  local dl, ox, oy, k = nil, 0, 0, 1
  local pool, used = {}, 0
  -- vectors are reused when their fields can be set (otherwise a new one each time)
  local reuse = pcall(function() local v = im.ImVec2(0, 0); v.x, v.y = 1, 2; assert(v.x == 1 and v.y == 2) end)
  local function V(x, y)
    if not reuse then return im.ImVec2(ox + x * k, oy + y * k) end
    used = used + 1
    local v = pool[used]
    if not v then v = im.ImVec2(0, 0); pool[used] = v end
    v.x, v.y = ox + x * k, oy + y * k
    return v
  end
  local function col(c)
    local a = clamp(c[4] or 1, 0, 1)
    return floor(clamp(c[1], 0, 255) + 0.5) + floor(clamp(c[2], 0, 255) + 0.5) * 256
      + floor(clamp(c[3], 0, 255) + 0.5) * 65536 + floor(a * 255 + 0.5) * 16777216
  end
  -- stretch: how much the game stretches the UI to the screen (screen px per UI px; 1 when the
  -- UI is drawn at the screen's resolution). The softening that best matches the app's own
  -- strokes, found against the app's renderer drawn at the UI's resolution and stretched:
  -- none unstretched, about 0.9 px at 1.33 (1920 wide on 2560), 1 px at 1.5.
  function g.begin(drawList, x0, y0, scale, stretch)
    dl, ox, oy, k, used = drawList, x0, y0, scale, 0
    soft = M.STROKE_SOFT or clamp(((stretch or 1) - 1) * SOFT_PER_STRETCH, 0, SOFT_MAX)
  end
  function g.frameDone() used = 0 end
  local function path(pts, n)
    dl:PathClear()
    for i = 1, n do dl:PathLineTo(V(pts[i * 2 - 1], pts[i * 2])) end
  end
  function g.fill(pts, n, c)
    if not c or n < 3 then return end
    path(pts, n)
    dl:PathFillConvex(col(c))
    used = 0
  end
  -- Strokes: optionally softened (soft > 0, device px) to look like the app's own, which the
  -- game draws at the UI's resolution and stretches to the screen: under the stroke a band soft
  -- px wider at half strength, and the stroke itself soft px narrower, its strength set so the
  -- two together carry the same ink as one plain stroke. emit() lays down the path each time.
  local function strokeWith(emit, c, w)
    w = max(0.5, w)
    local a = clamp(c[4] or 1, 0, 1)
    if soft > 0 and w > soft + 0.5 then
      local half = a * 0.5
      emit(); dl:PathStroke(col({ c[1], c[2], c[3], half }), 0, w + soft)
      emit(); dl:PathStroke(col({ c[1], c[2], c[3], half / (1 - half) }), 0, w - soft)
    else
      emit(); dl:PathStroke(col(c), 0, w)
    end
    used = 0
  end
  -- A closed outline is stroked as an open path that starts and ends halfway along its first
  -- side, so every corner gets a proper joint without ImGui's closed-path flag (which the game
  -- doesn't honour: the closing side went missing).
  function g.stroke(pts, n, c, w, closed)
    if n < 2 then return end
    strokeWith(function()
      used = 0
      dl:PathClear()
      if closed and n > 2 then
        local mx, my = (pts[1] + pts[3]) / 2, (pts[2] + pts[4]) / 2
        dl:PathLineTo(V(mx, my))
        for i = 2, n do dl:PathLineTo(V(pts[i * 2 - 1], pts[i * 2])) end
        dl:PathLineTo(V(pts[1], pts[2]))
        dl:PathLineTo(V(mx, my))
      else
        for i = 1, n do dl:PathLineTo(V(pts[i * 2 - 1], pts[i * 2])) end
      end
    end, c, w * k)
  end
  function g.circleFill(x, y, r, c)
    dl:AddCircleFilled(V(x, y), r * k, col(c), 0)
    used = 0
  end
  -- a full circle: an arc all the way round, ending where it starts (a butt join, invisible)
  function g.circle(x, y, r, c, w)
    strokeWith(function() used = 0; dl:PathClear(); dl:PathArcTo(V(x, y), r * k, 0, 2 * pi, 0) end, c, w * k)
  end
  function g.arc(x, y, r, a0, a1, c, w)
    strokeWith(function() used = 0; dl:PathClear(); dl:PathArcTo(V(x, y), r * k, a0, a1, 0) end, c, w * k)
  end
  function g.cap(x, y, r, a, c)   -- a half disc of radius r at (x, y), its flat side facing angle a + pi/2..
    dl:PathClear()
    dl:PathArcTo(V(x, y), r * k, a, a + pi, 0)
    dl:PathFillConvex(col(c))
    used = 0
  end
  -- Text centred on cx, its baseline at y (the app's pixels), px high. Drawn the way the game's
  -- own ImGui windows draw text: the window's font scaled to the size, measured and drawn at that
  -- same scale, so the centring always fits what's drawn. (Text drawn straight into the draw
  -- list at a size of its own wasn't taken by the game, and fell back to the plain size.)
  local textFailed = false
  local function textAt(x, y, packed, s)
    im.SetCursorScreenPos(im.ImVec2(x, y))
    im.PushStyleColor1(im.Col_Text, packed)
    pcall(im.TextUnformatted, s)
    im.PopStyleColor(1)
  end
  -- width: how wide the app draws this text (its pixels). The font is scaled until ImGui
  -- measures the text that wide: the game's reported font size doesn't match what it draws, but
  -- its measurements do. Without a width, the reported size is all there is.
  function g.textCentered(cx, y, px, c, s, bold, width)
    local okB, w1 = pcall(function() im.SetWindowFontScale(1); return im.CalcTextSize(s).x end)
    if not okB or type(w1) ~= "number" or w1 <= 0 then return end
    local ok, err = pcall(function()
      local scale
      if width and width > 0 then scale = width * k / w1
      else scale = px * k / im.GetFontSize() end
      im.SetWindowFontScale(scale)
      local w = im.CalcTextSize(s).x
      -- the text is now px high on screen; the game's font puts the baseline TEXT_BASELINE of
      -- that below the top of the line (measured in the game: 1.04, where most fonts are about 0.8)
      local x, top = ox + cx * k - w / 2, oy + y * k - px * k * (M.TEXT_BASELINE or TEXT_BASELINE)
      local shadow, packed = col({ 0, 0, 0, 0.45 }), col(c)
      textAt(x + 0.8 * k, top + 0.8 * k, shadow, s)
      textAt(x - 0.6 * k, top + 0.6 * k, shadow, s)
      textAt(x, top, packed, s)
      if bold then textAt(x + 0.5 + 0.15 * k, top, packed, s) end
    end)
    pcall(im.SetWindowFontScale, 1)
    if not ok and not textFailed then   -- the rest still draws; said once
      textFailed = true
      if log then log('W', 'vgsDraw', 'balance text could not be drawn: ' .. tostring(err)) end
    end
  end
  return g
end

return M

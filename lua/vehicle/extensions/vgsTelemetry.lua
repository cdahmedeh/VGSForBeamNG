-- VGS Display : vehicle-side telemetry
-- ---------------------------------------------------------------------------
-- Measures, for every wheel of this vehicle:
--   * where it sits on the vehicle (captured once, in the vehicle's own frame)
--   * its live steering (yaw) angle, measured from the hub's axle nodes
--   * an estimate of how much of the tyre's grip is in use (0..1+)
--   * whether the tyre is sliding (grip limit exceeded)
--   * the torque being applied: +1 full drive ... 0 none ... -1 full braking
--   * whether ABS or ESC is acting on it (and, for the whole vehicle, traction control)
-- and sends it to the vgsHub game-engine extension, which forwards it to the UI.
--
-- Loaded on demand by vgsHub. Nothing is computed until setActive(true).
-- ---------------------------------------------------------------------------

local M = {}

-- ===== Tunables =============================================================
-- BeamNG doesn't expose a direct "friction used" figure per tyre, so grip use
-- is an estimate: the larger of (a) a force-based estimate and (b) contact-patch
-- slip relative to SLIP_PEAK. Calibrate SLIP_PEAK / SLIP_LIMIT in-game using the
-- app's numeric readout (click the app).
local SEND_HZ          = 30    -- updates per second sent to the UI
local MU_NOMINAL       = 1.0   -- assumed peak friction coefficient (road tyre, dry asphalt)
local SLIP_PEAK        = 1.5   -- m/s of contact-patch slip treated as 100 % grip used
local SLIP_LIMIT       = 2.0   -- m/s of slip above which the tyre counts as sliding (red fill)
local SLIP_RELEASE     = 0.8   -- sliding clears below SLIP_LIMIT * this (avoids flicker)
local SLIP_FULL        = 8.0   -- m/s of slip shown as the most intense red (full spin / lock-up)
local MIN_LOAD         = 150   -- N; below this a wheel is treated as off the ground
local GRIP_SMOOTHING   = 0.4   -- 0..1 per update; higher = snappier, lower = steadier
local ACCEL_SMOOTH_HZ  = 6     -- low-pass for measured acceleration (grip estimate and G-force dot)
local LOAD_SMOOTH_HZ   = 0.5   -- low-pass for the wheel load used to scale drive torque
local STANDSTILL_SPEED = 0.5   -- m/s; a held brake at standstill isn't counted as tyre force
-- Driver-assist indicators (ABS / TC / ESC)
local ASSIST_HOLD         = 0.3  -- s a dot stays lit after the last detection (ABS pulses fast)
local ASSIST_MIN_SPEED    = 1.0  -- m/s; ignore system braking below this (hill hold, auto-hold)
local ASSIST_BRAKE_MARGIN = 60   -- Nm of brake torque beyond what the pedals ask for = system braking
-- ===========================================================================

local G = 9.81

local active     = false
local sendTimer  = 0
local layout     = nil   -- [i] = { x, y, steerBase }   (metres, vehicle frame)
local layoutWait = 0
local bodyExtent = nil  -- { x0, x1, y0, y1 }: the whole vehicle's footprint (metres, vehicle frame)
local state      = {}    -- [i] = { grip, sliding, fzAvg }
local coupled    = {}    -- [objId] = number of couplers attached to that vehicle
local lastVel    = nil
local latAccel   = 0
local lonAccel   = 0
local assistClock = 0
local tcUntil = 0

-- per-wheel assist codes (2 was per-wheel TC; TC is now reported for the whole vehicle)
local IV_NONE, IV_ABS, IV_ESC = 0, 1, 3

-- electrics flags may be booleans or 0/1 numbers; nil means "this vehicle doesn't report it"
local function flag(value)
  if type(value) == "boolean" then return value end
  if type(value) == "number" then return value > 0.5 end
  return nil
end

local function clamp(v, lo, hi)
  if v < lo then return lo elseif v > hi then return hi end
  return v
end

local function round(v, digits)
  local m = 10 ^ (digits or 3)
  return math.floor(v * m + 0.5) / m
end

-- Vehicle forward and right unit vectors in world space.
local function basis()
  local fwd   = obj:getDirectionVector():normalized()
  local up    = obj:getDirectionVectorUp():normalized()
  local right = fwd:cross(up):normalized()
  return fwd, right
end

local function forEachWheel(fn)
  if not wheels or not wheels.wheels then return end
  for i = 0, tableSizeC(wheels.wheels) - 1 do
    local w = wheels.wheels[i]
    if w and w.node1 and w.node2 then fn(i, w) end
  end
end

-- Yaw of a wheel's axle in the vehicle's horizontal plane (radians, + = turned left),
-- plus the hub midpoint relative to the vehicle's reference node.
local function axleYaw(w, fwd, right)
  local p1 = obj:getNodePosition(w.node1)
  local p2 = obj:getNodePosition(w.node2)
  local axle = p2 - p1
  local f, r = axle:dot(fwd), axle:dot(right)
  if r < 0 then f, r = -f, -r end -- node order differs between left and right wheels
  return math.atan2(f, r), (p1 + p2) * 0.5
end

-- ===== Drivetrain map ======================================================
-- Finds every power source (combustion engine, electric motor), where it sits,
-- and which wheels it drives, by walking the powertrain device tree.
-- Device field names vary between BeamNG versions, so every lookup is defensive
-- and falls back to something sensible.

local drivetrain = nil   -- { sources = { {x, y, kind, est, wheels = {i,...}} }, driven = {[i]=true} }
local everDriven = {}    -- [i] = true once a wheel has received drive torque (live fallback)
local nodeCidByName = nil

local function resolveNode(n)
  if type(n) == "number" then return n end
  if type(n) ~= "string" or not (v and v.data and v.data.nodes) then return nil end
  if not nodeCidByName then
    nodeCidByName = {}
    for cid, node in pairs(v.data.nodes) do
      if type(node) == "table" and node.name then nodeCidByName[node.name] = node.cid or cid end
    end
  end
  return nodeCidByName[n]
end

-- Centroid (vehicle frame) of a list of node ids or names; nil if none resolve.
local function nodesCentroid(list, fwd, right)
  if type(list) ~= "table" then return nil end
  local sx, sy, n = 0, 0, 0
  for _, ref in pairs(list) do
    local cid = resolveNode(ref)
    if cid then
      local ok, p = pcall(function() return obj:getNodePosition(cid) end)
      if ok and p then sx, sy, n = sx + p:dot(right), sy + p:dot(fwd), n + 1 end
    end
  end
  if n == 0 then return nil end
  return sx / n, sy / n
end

-- Centroid of the nodes whose group name contains one of `includes` and none of `excludes`.
local function groupCentroid(fwd, right, includes, excludes)
  if not (v and v.data and v.data.nodes) then return nil end
  local list = {}
  for cid, node in pairs(v.data.nodes) do
    if type(node) == "table" then
      local groups = node.group
      if type(groups) == "string" then groups = { groups } end
      if type(groups) == "table" then
        for _, g in pairs(groups) do
          local s = type(g) == "string" and g:lower() or ""
          local hit = false
          for _, inc in ipairs(includes) do if s:find(inc, 1, true) then hit = true break end end
          if hit then
            for _, exc in ipairs(excludes) do if s:find(exc, 1, true) then hit = false break end end
          end
          if hit then
            list[#list + 1] = node.cid or cid
            break
          end
        end
      end
    end
  end
  return nodesCentroid(list, fwd, right)
end

-- Nodes whose group names the engine (combustion engines only).
local function engineGroupCentroid(fwd, right)
  return groupCentroid(fwd, right, { "engine" }, { "bay", "mount", "hood", "cover" })
end

local function isPowerSource(d)
  local t = type(d.type) == "string" and d.type or ""
  local tl = t:lower()
  if tl:find("starter") then return false end
  if type(d.deviceCategories) == "table" and d.deviceCategories.engine then return true end
  return tl:find("engine$") ~= nil or tl:find("motor$") ~= nil
end

local function collectDrivenWheels(device, wheelIdxByName, out, visited, depth)
  if depth > 64 or visited[device] then return end
  visited[device] = true
  local cw = device.connectedWheel or device.wheelName
  if type(cw) == "string" and wheelIdxByName[cw] then out[wheelIdxByName[cw]] = true end
  if type(device.children) == "table" then
    for _, child in pairs(device.children) do
      if type(child) == "table" then collectDrivenWheels(child, wheelIdxByName, out, visited, depth + 1) end
    end
  end
end

local function sourcePosition(d, fwd, right)
  local candidates = { d.torqueReactionNodes }
  if type(d.jbeamData) == "table" then
    candidates[#candidates + 1] = d.jbeamData.torqueReactionNodes_nodes
    candidates[#candidates + 1] = d.jbeamData.torqueReactionNodes
  end
  local section = v and v.data and d.name and v.data[d.name]
  if type(section) == "table" then
    candidates[#candidates + 1] = section.torqueReactionNodes_nodes
    candidates[#candidates + 1] = section.torqueReactionNodes
  end
  for _, list in ipairs(candidates) do
    local x, y = nodesCentroid(list, fwd, right)
    if x then return x, y end
  end
  return nil
end

-- ===== Simplified drive graph ==============================================
local unpack = unpack or table.unpack
-- Engine/motor -> gearbox -> differentials -> wheels, the way BeamNG's Powertrain app reads
-- the device tree, keeping only what the VGS draws. Clutches, plain shafts and torque
-- converters are passed through; a dual-tyre "dually" differential is part of the wheel.
-- Nodes are in pre-order (parents before children); p is the parent's index (0 = root).
local function devType(d) return type(d.type) == "string" and d.type or "" end

local function isGearbox(d)
  return devType(d):lower():find("gearbox$") ~= nil
end

local function diffKind(d)
  if type(d.visualType) == "string" then return d.visualType end
  if type(d.diffType) == "string" then return "differential_" .. d.diffType end
  return devType(d)
end

local function isDifferential(d)
  local t = devType(d)
  return t == "differential" or t == "splitShaft" or diffKind(d):lower():find("^differential") ~= nil
end

local function isDually(d) return diffKind(d):lower():find("dually") ~= nil end

-- open / lsd / locked, from the current mode first (a lockable diff switches modes),
-- then from the differential's type, as BeamNG's Powertrain app does
local function diffState(d)
  local mode = type(d.mode) == "string" and d.mode:lower() or ""
  if mode == "locked" then return "locked" end
  if mode == "open" then return "open" end
  if mode == "lsd" or mode == "viscous" then return "lsd" end
  if type(d.visualType) ~= "string" and type(d.diffType) ~= "string" and devType(d) == "differential" then
    return "open"   -- no type given: BeamNG's default differential is open
  end
  local kind = diffKind(d):lower()
  if kind:find("locked") then return "locked" end
  if kind:find("open") then return "open" end
  return "lsd"   -- lsd, viscous, activeLock, torqueVectoring, splitShaft
end

local function isDisconnected(d)
  return type(d.mode) == "string" and d.mode:lower() == "disconnected"
end

local function buildDriveGraph(sources, wheelIdxByName, fwd, right)
  local nodes, visited = {}, {}
  local function add(n) nodes[#nodes + 1] = n; return #nodes end

  local function walk(dev, parent, gates, depth, sawGearbox)
    if depth > 64 or visited[dev] then return end
    visited[dev] = true
    local cw = dev.connectedWheel or dev.wheelName
    if type(cw) == "string" and wheelIdxByName[cw] then
      local g = gates
      if dev.mode ~= nil then g = { unpack(gates) }; g[#g + 1] = dev end
      add({ k = "wheel", w = wheelIdxByName[cw], p = parent, gates = g })
      return
    end
    local here, childGates, sawGb = parent, gates, sawGearbox
    if not sawGearbox and isGearbox(dev) then
      here = add({ k = "gb", sub = devType(dev), p = parent, gates = gates, dev = dev, name = dev.name })
      childGates, sawGb = {}, true
    elseif isDifferential(dev) and not isDually(dev) then
      here = add({ k = "diff", p = parent, gates = gates, dev = dev, name = dev.name })
      childGates = {}
    elseif dev.mode ~= nil then
      -- shafts that can be disconnected (part-time 4WD), range boxes, etc.
      childGates = { unpack(gates) }; childGates[#childGates + 1] = dev
    end
    if type(dev.children) == "table" then
      for _, c in pairs(dev.children) do
        if type(c) == "table" then walk(c, here, childGates, depth + 1, sawGb) end
      end
    end
  end

  for si, s in ipairs(sources) do
    if s.dev then
      visited[s.dev] = true
      local root = add({ k = "src", si = si, p = 0, gates = {}, name = s.dev.name })
      if type(s.dev.children) == "table" then
        for _, c in pairs(s.dev.children) do
          if type(c) == "table" then walk(c, root, {}, 1, false) end
        end
      end
    end
  end

  -- Physical positions where the vehicle's structure names them; the app places the rest.
  local gx, gy = groupCentroid(fwd, right, { "transmission", "gearbox", "transaxle" }, { "mount", "tunnel", "cover", "cooler" })
  local tx, ty = groupCentroid(fwd, right, { "transfercase", "transfer_case" }, { "mount", "cover" })
  local gbDone, tcDone = false, false
  local wheelsUnder = {}
  for idx = #nodes, 1, -1 do   -- children come after parents, so walk backwards
    local n = nodes[idx]
    wheelsUnder[idx] = wheelsUnder[idx] or {}
    if n.k == "wheel" then wheelsUnder[idx][#wheelsUnder[idx] + 1] = n.w end
    if n.p > 0 then
      wheelsUnder[n.p] = wheelsUnder[n.p] or {}
      for _, w in ipairs(wheelsUnder[idx]) do wheelsUnder[n.p][#wheelsUnder[n.p] + 1] = w end
    end
  end
  for idx, n in ipairs(nodes) do
    if n.k == "gb" and gx and not gbDone then
      n.gx, n.gy, gbDone = gx, gy, true
    elseif n.k == "diff" and tx and not tcDone then
      local y0, y1 = math.huge, -math.huge
      for _, w in ipairs(wheelsUnder[idx]) do
        if layout[w] then y0, y1 = math.min(y0, layout[w].y), math.max(y1, layout[w].y) end
      end
      if y1 - y0 > 0.35 then n.gx, n.gy, tcDone = tx, ty, true end   -- spans axles: centre diff
    end
  end
  return nodes
end
-- ===========================================================================

local function mapDrivetrain(fwd, right)
  local result = { sources = {}, driven = {} }
  local wheelIdxByName = {}
  forEachWheel(function(i, w) if w.name then wheelIdxByName[w.name] = i end end)

  local devices = (powertrain and powertrain.getDevices) and powertrain.getDevices() or {}
  local usedEngineGroup = false

  for _, d in pairs(devices) do
    if type(d) == "table" and isPowerSource(d) then
      local drivenSet = {}
      collectDrivenWheels(d, wheelIdxByName, drivenSet, {}, 0)
      local wheelList = {}
      for i in pairs(drivenSet) do wheelList[#wheelList + 1] = i; result.driven[i] = true end
      table.sort(wheelList)

      local isElectric = (type(d.type) == "string" and d.type:lower():find("electric")) and true or false
      local x, y = sourcePosition(d, fwd, right)
      local estimated = false
      if not x and not isElectric and not usedEngineGroup then
        x, y = engineGroupCentroid(fwd, right)
        usedEngineGroup = x ~= nil
      end
      if not x then
        -- last resort: centre of the wheels it drives
        estimated = true
        local sx, sy, n = 0, 0, 0
        for _, i in ipairs(wheelList) do
          if layout[i] then sx, sy, n = sx + layout[i].x, sy + layout[i].y, n + 1 end
        end
        if n > 0 then x, y = sx / n, sy / n end
      end

      if x then
        result.sources[#result.sources + 1] = {
          x = x, y = y,
          kind = isElectric and "ev" or "ice",
          est = estimated,
          wheels = wheelList,
          dev = d,
        }
      end
    end
  end

  -- Only show power sources that drive wheels. Trailers and equipment can carry motors for
  -- hydraulics, winches or landing gear that would otherwise appear as stray motor symbols.
  -- Exception: if nothing was found driving wheels (unusual powertrain layout), keep the
  -- combustion engines so a car never loses its engine block.
  local anyDriving = false
  for _, s in ipairs(result.sources) do if #s.wheels > 0 then anyDriving = true end end
  local kept = {}
  for _, s in ipairs(result.sources) do
    if #s.wheels > 0 or (not anyDriving and s.kind == "ice") then kept[#kept + 1] = s end
  end
  result.sources = kept
  local okG, graph = pcall(buildDriveGraph, kept, wheelIdxByName, fwd, right)
  result.graph = okG and graph or {}
  if not okG then log('W', 'vgsTelemetry', 'drive graph failed: ' .. tostring(graph)) end
  return result
end
-- ===========================================================================

-- ===== Tyres per wheel =====================================================
-- A dual pair can reach us as two wheels (handled by the UI), or as ONE wheel whose
-- tyre is physically a single wide tyre with dual-tyre visuals. For the second case
-- we look for, in order: an explicit dual flag, a tyre mesh named "dual" on this
-- wheel's node groups, or a truck-sized tyre much wider than it is tall.
local DUAL_WIDTH_RATIO = 1.0   -- tyre width / radius above which a big wheel counts as a dual pair
local DUAL_MIN_RADIUS  = 0.42  -- m; only truck/bus-sized wheels qualify by width

local function wheelJbeam(i, w)
  local list = v and v.data and v.data.wheels
  if type(list) ~= "table" then return nil end
  local d = list[i]
  if type(d) == "table" and (d.name == nil or d.name == w.name) then return d end
  for _, e in pairs(list) do
    if type(e) == "table" and e.name == w.name then return e end
  end
  return nil
end

local function groupSet(...)
  local set = {}
  for _, g in ipairs({ ... }) do
    if type(g) == "string" then set[g] = true
    elseif type(g) == "table" then
      for _, n in pairs(g) do if type(n) == "string" then set[n] = true end end
    end
  end
  return set
end

local function hasDualFlexbody(groups)
  local flexbodies = v and v.data and v.data.flexbodies
  if type(flexbodies) ~= "table" or not next(groups) then return false end
  for _, fb in pairs(flexbodies) do
    if type(fb) == "table" and type(fb.mesh) == "string" and fb.mesh:lower():find("dual") then
      local fbGroups = groupSet(fb.group, fb["[group]"])
      for name in pairs(fbGroups) do
        if groups[name] then return true end
      end
    end
  end
  return false
end

-- returns tyre count, wheelOffset (m), reason, radius, tyre width
local function tyreInfo(i, w)
  local d = wheelJbeam(i, w) or {}
  local function num(key)
    local x = w[key]
    if type(x) ~= "number" then x = d[key] end
    return type(x) == "number" and x or nil
  end
  local radius    = num("radius")
  local tireWidth = num("tireWidth") or num("hubWidth")
  local offset    = num("wheelOffset") or 0

  for _, key in ipairs({ "isDual", "dual", "dualWheel", "dualTire", "dualTyre", "isDualWheel" }) do
    local x = w[key]
    if x == nil then x = d[key] end
    if x == true or x == 1 then return 2, offset, "flag " .. key, radius, tireWidth end
  end
  if hasDualFlexbody(groupSet(d.group, d.hubGroup, w.group, w.hubGroup)) then
    return 2, offset, "dual tyre mesh", radius, tireWidth
  end
  if radius and tireWidth and radius >= DUAL_MIN_RADIUS and tireWidth / radius > DUAL_WIDTH_RATIO then
    return 2, offset, "wide truck tyre", radius, tireWidth
  end
  return 1, offset, nil, radius, tireWidth
end

local function captureLayout(fwd, right, steeringCentred)
  layout, state = {}, {}
  forEachWheel(function(i, w)
    local yaw, mid = axleYaw(w, fwd, right)
    local okT, tyres, offset, _, radius, width = pcall(tyreInfo, i, w)
    if not okT then tyres, offset, radius, width = 1, 0, nil, nil end
    local axle = obj:getNodePosition(w.node2) - obj:getNodePosition(w.node1)
    local axleLen = axle:length()
    local x = mid:dot(right)
    if offset ~= 0 and axleLen > 1e-3 then
      -- wheelOffset shifts the tyre along the axle (node1 -> node2) from the axle-node midpoint
      x = x + offset * axle:dot(right) / axleLen
    end
    -- real tyre size: diameter from the radius, width from the tyre (BeamNG's own default
    -- for a missing width is the distance between the axle nodes)
    radius = radius or ((type(w.radius) == "number" and w.radius > 0.05) and w.radius or nil)
    width = width or ((axleLen > 0.02) and axleLen or nil)
    if width and tyres > 1 and radius and width > radius * 0.9 then
      width = width / tyres * 0.92   -- one wide tyre standing in for a dual pair: split it
    end
    layout[i] = {
      x = x,
      y = mid:dot(fwd),
      tyres = tyres,
      radius = radius,
      width = width,
      -- removes static toe so straight-ahead reads as 0
      steerBase = steeringCentred and yaw or 0,
    }
    state[i] = { grip = 0, sliding = false, fzAvg = math.max(w.downForceRaw or w.downForce or 0, 0) }
  end)

  -- Footprint of the whole vehicle from every node, so a trailer's box is as long as the
  -- trailer, not just the stretch between its wheels.
  bodyExtent = nil
  if v and v.data and type(v.data.nodes) == "table" then
    local x0, x1, y0, y1 = math.huge, -math.huge, math.huge, -math.huge
    for cid, node in pairs(v.data.nodes) do
      local id = type(node) == "table" and (node.cid or cid) or nil
      if type(id) == "number" then
        local okP, p = pcall(function() return obj:getNodePosition(id) end)
        if okP and p then
          local x, y = p:dot(right), p:dot(fwd)
          x0, x1 = math.min(x0, x), math.max(x1, x)
          y0, y1 = math.min(y0, y), math.max(y1, y)
        end
      end
    end
    if x0 < x1 and y0 < y1 then bodyExtent = { x0 = x0, x1 = x1, y0 = y0, y1 = y1 } end
  end

  local ok, dt = pcall(mapDrivetrain, fwd, right)
  drivetrain = ok and dt or { sources = {}, driven = {} }
  if not ok then log('W', 'vgsTelemetry', 'drivetrain map failed: ' .. tostring(dt)) end
end

local function resetState()
  drivetrain, everDriven, nodeCidByName = nil, {}, nil
  assistClock, tcUntil = 0, 0
  layout, state = nil, {}
  layoutWait, sendTimer = 0, 0
  lastVel, latAccel, lonAccel = nil, 0, 0
end

local function coupledList()
  local list = {}
  for id in pairs(coupled) do list[#list + 1] = id end
  return list
end

local function buildPayload(fwd, right, speed)
  local ev = electrics.values
  local throttle = ev.throttle or 0
  local wheelsOut = {}

  -- Driver assists. ABS is reported per wheel. TC acts on the engine, so it's one
  -- vehicle-level flag. ESC is shown on the wheels it brakes, found from brake torque
  -- the pedals didn't ask for.
  local brakeIn = clamp(ev.brake or 0, 0, 1)
  local parkIn  = clamp(ev.parkingbrake or ev.parkingbrake_input or 0, 0, 1)
  local absOn, tcsOn, escOn = flag(ev.absActive), flag(ev.tcsActive), flag(ev.escActive)
  if flag(ev.abs) == true then absOn = true end   -- BeamNG's Pedals app reads ABS activity from 'abs'
  local systemFlagsKnown = tcsOn ~= nil or escOn ~= nil
  -- ESC must be fitted (hasESC) and intervening right now (escActive); unknown counts as no.
  local escIntervening = flag(ev.hasESC) == true and escOn == true
  local assists = {}   -- per wheel: { entry, S, abs, esc }
  local tcFromBrakes = false

  -- Live drive graph: each differential's lock state, shafts that are disconnected right now
  -- (e.g. part-time 4WD in 2WD), and which wheels are actually connected to a power source.
  local graph = drivetrain and drivetrain.graph or {}
  local graphOut, liveDriven, live = {}, {}, {}
  for idx, n in ipairs(graph) do
    local dc = false
    for _, g in ipairs(n.gates or {}) do
      if isDisconnected(g) then dc = true break end
    end
    live[idx] = (n.p == 0) or (live[n.p] and not dc) or false
    if n.k == "wheel" and live[idx] then liveDriven[n.w] = true end
    graphOut[idx] = {
      -- si: which entry of `src` this engine is, counted from 0 like the app's arrays
      k = n.k, p = n.p, w = n.w, si = n.si and (n.si - 1) or nil, sub = n.sub,
      st = (n.k == "diff" and n.dev) and diffState(n.dev) or nil,   -- open / lsd / locked
      dc = dc and 1 or nil,                                          -- disconnected from its parent
      gx = n.gx and round(n.gx, 3) or nil, gy = n.gy and round(n.gy, 3) or nil,   -- physical position
    }
  end
  local hasGraph = #graph > 0

  forEachWheel(function(i, w)
    local L, S = layout[i], state[i]
    if not L or not S then return end

    local fz       = w.downForceRaw or w.downForce or 0
    local radius   = (w.radius and w.radius > 0.05) and w.radius or 0.3
    local drive    = w.propulsionTorque or 0
    local brake    = math.abs(w.brakingTorque or 0)
    local brakeMax = w.brakeTorque or 0
    local slip     = math.abs(w.lastSlip or 0)
    local broken   = w.isBroken and true or false
    local airborne = broken or fz < MIN_LOAD
    if math.abs(drive) > 1 then everDriven[i] = true end
    local driven
    if hasGraph then driven = liveDriven[i] or false
    else driven = (drivetrain and drivetrain.driven[i]) or everDriven[i] end

    -- Slow-moving load, used to express drive torque as a share of what the tyre can take.
    S.fzAvg = S.fzAvg + (math.max(fz, 0) - S.fzAvg) * clamp(LOAD_SMOOTH_HZ / SEND_HZ, 0, 1)
    local tyreTorqueCapacity = MU_NOMINAL * math.max(S.fzAvg, 300) * radius

    -- Grip use --------------------------------------------------------------
    local use = 0
    if not airborne then
      local brakeTorque = (speed > STANDSTILL_SPEED) and brake or 0
      local fx = math.max(math.abs(drive), brakeTorque) / radius   -- longitudinal (N)
      local fy = fz * math.abs(latAccel) / G                       -- lateral share by load (N)
      local forceUse = math.sqrt(fx * fx + fy * fy) / (MU_NOMINAL * fz)
      use = math.max(forceUse, slip / SLIP_PEAK)
    end
    S.grip = S.grip + (use - S.grip) * GRIP_SMOOTHING

    if airborne then
      S.sliding = false
    elseif slip > SLIP_LIMIT then
      S.sliding = true
    elseif slip < SLIP_LIMIT * SLIP_RELEASE then
      S.sliding = false
    end

    -- How far past the limit: 0 just broken loose .. 1 at SLIP_FULL, on a log scale
    -- (slip grows quickly once a tyre lets go, so linear would jump straight to the top).
    local severity = 0
    if S.sliding then
      local floor = SLIP_LIMIT * SLIP_RELEASE
      severity = clamp(math.log(math.max(slip, floor) / floor) / math.log(SLIP_FULL / floor), 0, 1)
    end
    S.severity = (S.severity or 0) + (severity - (S.severity or 0)) * GRIP_SMOOTHING

    -- Torque application: + drive, - braking (engine braking / regen count as braking)
    local driveFrac, brakeFrac = 0, 0
    if throttle > 0.02 then
      driveFrac = math.abs(drive) / tyreTorqueCapacity
    else
      brakeFrac = math.abs(drive) / tyreTorqueCapacity
    end
    -- what flows through the driveline only (no friction brakes): tints shafts and axles
    local driveline = clamp(driveFrac, 0, 1) - clamp(brakeFrac, 0, 1)
    if brakeMax > 0 then brakeFrac = math.max(brakeFrac, brake / brakeMax) end
    local torque = clamp(driveFrac, 0, 1) - clamp(brakeFrac, 0, 1)

    -- Steering ----------------------------------------------------------------
    local steer = axleYaw(w, fwd, right) - L.steerBase
    if steer >  math.pi / 2 then steer = steer - math.pi end
    if steer < -math.pi / 2 then steer = steer + math.pi end

    -- Assist detection ------------------------------------------------------
    local expected = brakeIn * brakeMax + parkIn * (w.parkingTorque or 0)
    local abs = false
    if w.absActive ~= nil then
      abs = w.absActive == true or w.absActive == 1
    elseif absOn then
      -- no per-wheel flag: ABS is releasing this wheel's brake below what was requested
      local requested = w.desiredBrakingTorque or expected
      abs = brakeIn > 0.05 and requested > ASSIST_BRAKE_MARGIN and brake < requested * 0.85
    end
    -- Brake torque the pedals didn't ask for comes from TC or ESC. A spinning driven wheel
    -- under power is TC's job (shown at the engine, not per wheel). ESC is only ever shown
    -- when the car reports it's fitted with ESC and ESC is actively intervening.
    local esc = false
    local systemBrake = speed > ASSIST_MIN_SPEED and brake > expected * 1.1 + ASSIST_BRAKE_MARGIN
    if systemBrake then
      local spinningUnderPower = driven and throttle > 0.05 and slip > SLIP_PEAK * 0.3
      if escIntervening and not (tcsOn and spinningUnderPower) then
        esc = true
      elseif tcsOn or (not systemFlagsKnown and spinningUnderPower) then
        tcFromBrakes = true
      end
    end

    local entry = {
      i  = i,                      -- wheel id (matches src.w)
      d  = driven and 1 or 0,      -- connected to a power source
      nt = L.tyres or 1,           -- tyres this wheel represents (2 = dual pair modelled as one)
      rd = L.radius and round(L.radius, 3) or nil,   -- tyre radius (m)
      wd = L.width and round(L.width, 3) or nil,     -- width of each tyre (m)
      x  = round(L.x, 3),          -- metres right of reference node
      y  = round(L.y, 3),          -- metres forward of reference node
      s  = round(steer, 4),        -- steering yaw, radians, + = left
      g  = round(S.grip, 3),       -- grip used, 1 = 100 %
      e  = S.sliding and 1 or 0,   -- grip limit exceeded
      ex = S.sliding and round(S.severity, 3) or 0,   -- how far past the limit, 0..1
      t  = round(torque, 3),       -- -1 full brake .. +1 full drive
      dr = round(driveline, 3),    -- driveline only: + drive, - engine braking / regen
      b  = broken and 1 or 0,
      sl = round(slip, 2),         -- raw contact slip (m/s), for calibration
      fz = math.floor(fz),         -- wheel load (N), for calibration
      iv = IV_NONE,                -- assist acting on this wheel (filled in below)
    }
    wheelsOut[#wheelsOut + 1] = entry
    assists[#assists + 1] = { entry = entry, S = S, abs = abs, esc = esc }
  end)

  -- ESC steers the car by braking individual wheels. If every wheel shows the same extra
  -- braking, it isn't stability control (some other system, or a pedal/torque mismatch).
  local escCount = 0
  for _, a in ipairs(assists) do if a.esc then escCount = escCount + 1 end end
  if escCount > 0 and escCount == #assists then
    for _, a in ipairs(assists) do a.esc = false end
  end

  -- Per wheel: ABS and ESC, each held briefly so pulsing stays visible; ESC wins over ABS.
  for _, a in ipairs(assists) do
    local S = a.S
    if a.abs then S.absUntil = assistClock + ASSIST_HOLD end
    if a.esc then S.escUntil = assistClock + ASSIST_HOLD end
    if (S.escUntil or 0) > assistClock then a.entry.iv = IV_ESC
    elseif (S.absUntil or 0) > assistClock then a.entry.iv = IV_ABS end
  end

  -- Vehicle level: traction control (cuts engine torque, and may brake spinning wheels).
  if tcsOn or tcFromBrakes then tcUntil = assistClock + ASSIST_HOLD end

  local sources = {}
  for _, s in ipairs(drivetrain and drivetrain.sources or {}) do
    sources[#sources + 1] = {
      x = round(s.x, 3), y = round(s.y, 3),
      k = s.kind,                  -- "ice" or "ev"
      e = s.est and 1 or 0,        -- position estimated (not found in the vehicle data)
      w = s.wheels,                -- wheel ids this source drives
    }
  end

  -- Inputs for the rim arcs, read the same way as BeamNG's own Steering and Pedals apps:
  -- steering_input is negative to the left (we send + = left), and throttle / brake are the
  -- applied pedal values (brake includes the automatic hold at standstill).
  local inputs = {
    s = round(clamp(-(ev.steering_input or 0), -1, 1), 3),
    t = round(clamp(ev.throttle or ev.throttle_input or 0, 0, 1), 3),
    b = round(clamp(ev.brake or ev.brake_input or 0, 0, 1), 3),
  }

  local pos = obj:getPosition()
  return {
    inp = inputs,
    ext = bodyExtent and {
      x0 = round(bodyExtent.x0, 2), x1 = round(bodyExtent.x1, 2),
      y0 = round(bodyExtent.y0, 2), y1 = round(bodyExtent.y1, 2),
    } or nil,
    -- G-force as felt by the driver (opposite to the acceleration), in g:
    -- x + = pushed right (turning left), y + = pushed forward (braking)
    gf = { x = round(-latAccel / G, 3), y = round(-lonAccel / G, 3) },
    src = sources,
    dt = hasGraph and graphOut or nil,   -- simplified drive graph (see buildDriveGraph)
    tc = (tcUntil > assistClock) and 1 or 0,   -- traction control intervening

    id = obj:getId(),
    px = round(pos.x, 2), py = round(pos.y, 2),
    hx = round(fwd.x, 4), hy = round(fwd.y, 4),
    c  = coupledList(),
    w  = wheelsOut,
  }
end

local function updateGFX(dt)
  if not active or not dt or dt <= 0 then return end

  local fwd, right = basis()
  assistClock = assistClock + dt

  -- Lateral acceleration from the change in velocity, projected on the vehicle's right axis.
  local vel = obj:getVelocity()
  if lastVel then
    local dv = vel - lastVel
    local k = clamp(dt * ACCEL_SMOOTH_HZ, 0, 1)
    latAccel = latAccel + (dv:dot(right) / dt - latAccel) * k
    lonAccel = lonAccel + (dv:dot(fwd) / dt - lonAccel) * k
  end
  lastVel = vec3(vel)

  -- Capture the wheel layout once, ideally with the steering centred.
  if not layout then
    layoutWait = layoutWait + dt
    local steerIn = math.abs(electrics.values.steering_input or 0)
    if steerIn < 0.02 then
      captureLayout(fwd, right, true)
    elseif layoutWait > 1.5 then
      captureLayout(fwd, right, false)
    else
      return
    end
  end

  sendTimer = sendTimer + dt
  if sendTimer < 1 / SEND_HZ then return end
  sendTimer = 0

  local payload = buildPayload(fwd, right, vel:length())
  obj:queueGameEngineLua(string.format(
    "if extensions.vgsHub then extensions.vgsHub.onVehicleJson(%q) end", jsonEncode(payload)))
end

local function setActive(on)
  on = on and true or false
  if on and not active then resetState() end
  active = on
end

-- Couplers (fifth wheel, tow hitch, articulation joints between separate vehicles)
local function onCouplerAttached(nodeId, obj2id)
  if type(obj2id) == "number" and obj2id ~= obj:getId() then
    coupled[obj2id] = (coupled[obj2id] or 0) + 1
  end
end

local function onCouplerDetached(nodeId, obj2id)
  if type(obj2id) == "number" and coupled[obj2id] then
    coupled[obj2id] = coupled[obj2id] - 1
    if coupled[obj2id] <= 0 then coupled[obj2id] = nil end
  end
end

-- Diagnostic: lists every wheel and how its tyres were read. Run in the vehicle Lua console:
--   extensions.load("vgsTelemetry") extensions.vgsTelemetry.dumpWheels()
local function dumpWheels()
  local fwd, right = basis()
  forEachWheel(function(i, w)
    local okT, tyres, offset, reason, radius, width = pcall(tyreInfo, i, w)
    local _, mid = axleYaw(w, fwd, right)
    local d = wheelJbeam(i, w) or {}
    local line = string.format(
      "[%d] %s  nodes %s/%s  x=%.2f y=%.2f  radius=%s width=%s offset=%s  tyres=%s (%s)  group=%s hubGroup=%s",
      i, tostring(w.name), tostring(w.node1), tostring(w.node2), mid:dot(right), mid:dot(fwd),
      tostring(radius), tostring(width), tostring(offset), okT and tostring(tyres) or "error",
      tostring(okT and (reason or "single") or tyres), tostring(d.group or w.group), tostring(d.hubGroup or w.hubGroup))
    log('I', 'vgsTelemetry', line)
    print(line)
  end)
end

-- Diagnostic: the drivetrain as the VGS reads it. In the vehicle Lua console:
--   extensions.load("vgsTelemetry") extensions.vgsTelemetry.dumpDrivetrain()
local function dumpDrivetrain()
  local function out(line) log('I', 'vgsTelemetry', line); print(line) end
  local devices = (powertrain and powertrain.getDevices) and powertrain.getDevices() or {}
  out("-- powertrain devices --")
  for name, d in pairs(devices) do
    if type(d) == "table" then
      local kids = {}
      for _, c in pairs(type(d.children) == "table" and d.children or {}) do
        if type(c) == "table" then kids[#kids + 1] = tostring(c.name) end
      end
      out(string.format("%s  type=%s visualType=%s diffType=%s mode=%s wheel=%s -> [%s]",
        tostring(name), tostring(d.type), tostring(d.visualType), tostring(d.diffType), tostring(d.mode),
        tostring(d.connectedWheel), table.concat(kids, ", ")))
    end
  end
  out("-- what the VGS draws --")
  local graph = drivetrain and drivetrain.graph or {}
  if #graph == 0 then out("(nothing yet: open the app with this vehicle first)") end
  for idx, n in ipairs(graph) do
    out(string.format("%d. %s %s parent=%d%s%s%s", idx, n.k, tostring(n.name or (n.w and ("wheel " .. n.w)) or ""),
      n.p, n.sub and ("  " .. n.sub) or "", n.dev and n.k == "diff" and ("  " .. diffState(n.dev)) or "",
      n.gx and string.format("  located x=%.2f y=%.2f", n.gx, n.gy) or ""))
  end
end

M.dumpWheels        = dumpWheels
M.dumpDrivetrain    = dumpDrivetrain
M.onExtensionLoaded = resetState
M.onReset           = resetState
M.updateGFX         = updateGFX
M.setActive         = setActive
M.onCouplerAttached = onCouplerAttached
M.onCouplerDetached = onCouplerDetached

return M

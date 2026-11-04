-- VGS Display : vehicle-side telemetry
-- ---------------------------------------------------------------------------
-- Runs in each displayed vehicle's own Lua. Every graphics frame it updates, for every wheel:
--   * where it sits on the vehicle (captured once, in the vehicle's own frame)
--   * its live steering angle, measured from the hub's axle nodes
--   * how much of the tyre's grip is in use (0..1+) and whether it's sliding
--   * the torque on it: +1 full drive ... 0 none ... -1 full braking
--   * which driver assist (ABS, traction control, ESC) is acting on it
-- plus the driver's inputs, the G-force, how much the car is actually turning and its
-- understeer / oversteer balance.
--
-- Whenever the UI is ready for a new frame (the same handshake BeamNG's own gauges use) it
-- sends the latest values straight to the VGS Display app as the 'VGSData' UI hook. The layout
-- (wheel positions, tyre sizes, drivetrain) goes in a separate block, only when it changes and
-- every couple of seconds. The extra numbers for the app's numbers mode are only worked out
-- while that mode is on.
--
-- Loaded and switched on by the vgsHub game-engine extension; idle until setActive(true).
-- ---------------------------------------------------------------------------

local M = {}

-- ===== Tunables =============================================================
-- Sending
local MAX_SEND_HZ      = 0     -- 0: one update per UI frame (lowest latency, no queueing); else a cap
local FALLBACK_HZ      = 60    -- update rate if the game doesn't report when the UI wants a frame
local KEEPALIVE        = 0.25  -- s: send anyway if the UI hasn't asked for this long
local STATIC_EVERY     = 2     -- s: the layout is re-sent this often (a reloaded UI picks it up)
local PING_EVERY       = 0.5   -- s: liveness and couplings, to the game-engine hub
-- Grip. BeamNG doesn't expose a "friction used" figure per tyre, so grip use is an estimate:
-- the larger of a force-based estimate and contact-patch slip relative to SLIP_PEAK.
local MU_NOMINAL       = 1.0   -- assumed peak friction coefficient (road tyre, dry asphalt)
local SLIP_PEAK        = 1.5   -- m/s of contact-patch slip treated as 100 % grip used
local SLIP_LIMIT       = 2.0   -- m/s of slip above which the tyre counts as sliding
local SLIP_RELEASE     = 0.8   -- sliding clears below SLIP_LIMIT * this (no flicker)
-- How red a sliding tyre is, from its slip ratio (slip speed / road speed). Real tyres peak at
-- about 10-15 % slip and stay within a few percent of peak out to about 30 %, so that band stays
-- pink; the red deepens from there to a locked or spinning wheel at 100 %.
local SLIP_RATIO_PINK  = 0.30
local SLIP_RATIO_FULL  = 1.00
local PINK_SEVERITY    = 0.2   -- how far towards deep red the colour gets by the end of the pink band
local RATIO_MIN_SPEED  = 5.0   -- m/s; slip ratio is taken against at least this (no /0 at a crawl)
local MIN_LOAD         = 150   -- N; below this a wheel is treated as off the ground
local AIR_SHOW_AFTER   = 0.25  -- s a wheel must be unloaded before it's shown off the ground (not every bump)
local LIGHT_FRAC       = 0.25  -- a wheel carrying less than this share of its normal load is nearly off the ground
local LIGHT_HZ         = 2     -- smoothing of the load for that (a bump doesn't flash it)
local LIGHT_REF_TAU    = 2     -- s: how slowly the normal load is followed
local GRIP_SMOOTHING   = 0.4   -- share of the gap closed every 1/30 s (higher = snappier)
local ACCEL_SMOOTH_HZ  = 6     -- low-pass on the lateral acceleration the grip estimate uses
local LOAD_SMOOTH_HZ   = 0.5   -- low-pass on the wheel load used to scale drive torque
local STANDSTILL_SPEED = 0.5   -- m/s; a held brake at standstill isn't counted as tyre force
-- G-force dot. The acceleration is the least-squares slope of the velocity over GF_WINDOW
-- (which averages out the body's vibration far better than a difference between two samples),
-- then a "One Euro" filter: strong smoothing while the force holds steady, so the dot sits
-- still, opening up as the force changes, so it doesn't trail behind. In a simulated test with
-- body vibration it's as steady as a plain 0.12 s window with a 12 Hz low-pass, with less than
-- half the delay (about 50 ms instead of 120).
local GF_WINDOW        = 0.10  -- s of velocity history in each slope
local GF_MIN_CUTOFF    = 1.5   -- Hz: smoothing while steady (lower = stiller)
local GF_BETA          = 4     -- Hz per g/s: how much it opens up as the force changes
local GF_D_CUTOFF      = 1     -- Hz: smoothing of the rate of change itself
-- Direction marker: how much the car is actually turning, on the steering arc's scale
-- (see updateTravel). It can run on past a quarter, all the way round, in slides and spins.
local TRAVEL_SMOOTH_HZ = 15    -- low-pass on each axle's direction of travel
local TRAVEL_WINDOW    = 0.06  -- s; each axle's movement is measured across this long a stretch
local YAW_SMOOTH_HZ    = 12    -- light low-pass on the yaw rate
local TRAVEL_FADE_LO   = 0.5   -- m/s; below this the direction is too noisy to show
local TRAVEL_FADE_HI   = 1.5   -- m/s; fully shown from here
local TRAVEL_MAX       = 4     -- furthest the marker goes, in quarter turns (4 = the whole circle)
local LOCK_DEFAULT     = 0.6   -- rad; road-wheel angle at full lock until it's been measured
local CENTRE_INPUT     = 0.004 -- steering input below which the steering counts as centred (~0.1 deg of road wheel)
local ESC_BRAKE_MARGIN = 50    -- Nm of brake request beyond the pedals' share that counts as assist braking
-- Marker and balance-colour tuning. In a table because LuaJIT allows a function at most 60
-- outside local variables.
local TUNE = {}
TUNE.REAR_GRIP_SLIP   = 0.14  -- rad (~8 deg) of rear slide up to which the rear counts as gripping
TUNE.REAR_SLIDE_SLIP  = 0.35  -- rad (~20 deg) from which it's fully sliding (marker = front vs body)
-- While the rear grips, the marker is wheelbase x yaw rate / forward speed: exact for a rigid
-- car, and read from the physics yaw rate, so free of the hubs' vibration. A running
-- least-squares fit keeps it calibrated to the hub measurement.
TUNE.TURN_CAL_TAU     = 5     -- s of history in that calibration
-- The marker is drawn in steering-input units with the ratio the front wheels show right now: a
-- running least-squares slope of front-wheel angle against input, each frame weighted by how far
-- you're steering, so straights (input near zero) add no noise.
TUNE.RATIO_TAU        = 1.0   -- s of history in that slope
TUNE.CENTRE_TAU       = 3     -- s for each wheel's straight-ahead reference to settle while driving straight
-- The steering scale the arc and the marker share (the app draws with the k sent here):
-- asinh(k x) / asinh(k), so the few degrees you steer at speed are easy to read. k is chosen so
-- the steering a 1 g corner needs at this speed fills STEER_TARGET of the quarter turn, never
-- below STEER_EXPAND (low speed) or above STEER_K_MAX. STEER_EXPAND = STEER_TARGET = 0: straight.
TUNE.STEER_EXPAND     = 20
TUNE.STEER_TARGET     = 0.6
TUNE.STEER_K_MAX      = 400
-- Smoothing the marker, done on where it's drawn (degrees round the rim, so noise is judged as
-- the eye sees it, after the scale's magnification). A "One Euro" filter: strong smoothing
-- while it holds still, opening up as it moves, from its own movement and, without any delay,
-- a little from how fast you're turning the steering (a clean signal; only a little, because
-- the car hardly responds to small quick corrections). The yaw rate it starts from has only a
-- light filter of its own.
-- In a simulated test with yaw-rate noise and hub vibration, against the earlier fixed
-- smoothing: about twice as steady on a straight at highway speed, three to four times in a
-- curve, and the delay behind the real turn of the car cut from 60-84 ms to 26-36 ms.
TUNE.MARK_MIN_CUTOFF  = 0.3   -- Hz while still (lower = stiller)
TUNE.MARK_BETA        = 0.005 -- Hz per deg/s of its own movement (slides, the car settling)
TUNE.MARK_D_CUTOFF    = 0.5   -- Hz: smoothing of that movement estimate
TUNE.MARK_STEER_GAIN  = 0.06  -- Hz per deg/s of steering movement (on the same scale)
TUNE.MARK_STEER_CUTOFF = 8    -- Hz: smoothing of the steering's movement
-- Big, fast swings (a slide, a spin) open it almost at once: a second, quicker estimate of its
-- movement opens it with the square of the speed above MARK_FAST_FROM, a speed noise doesn't
-- reach (in the simulated tests noise made it look like at most about 150 deg/s of rim; a
-- slide moves it at 400-1000 deg/s).
TUNE.MARK_FAST_FROM   = 180   -- deg/s of rim
TUNE.MARK_BETA2       = 0.002 -- Hz per (deg/s)^2 above that
TUNE.MARK_D_FAST_CUTOFF = 2   -- Hz: smoothing of that quicker estimate
TUNE.MARK_YAW_HZ      = 10    -- light low-pass on the yaw rate the marker uses, Hz (0 = none)
-- Understeer / oversteer (the marker's colour): rear slip angle minus front, in the direction
-- the car is rotating. + = rear sliding more (oversteer), - = front (understeer).
-- Once the tyres' stiffness is known (the grip model, below: BeamNG's own calibration, or
-- learnt), understeer and the warnings come from how near each axle is to its limit, and the
-- car's own designed balance is taken out of the oversteer test (as BeamNG's stability control
-- does). Until then, the fixed slip angles below are used.
TUNE.BAL_DEADBAND     = 0.05  -- rad (~3 deg) of difference that still counts as neutral
TUNE.BAL_FULL         = 0.21  -- rad (~12 deg) of difference shown as the full colour
TUNE.BAL_SLIP_START   = 0.08  -- rad (~4.5 deg): the rear must pass this to colour at all
TUNE.BAL_SLIP_FULL    = 0.14  -- rad (~8 deg, around a road tyre's peak): full colour from here
TUNE.BAL_MIN_YAW      = 0.15  -- rad/s of rotation before it's shown at full strength
-- A controlled drift is shown in its own colour (aquamarine), full magenta being kept for
-- oversteer that's getting away. A slide counts as controlled when the countersteer matches it
-- (the front tyres slip only a few degrees: the steering points about where the front is
-- going) and it isn't growing fast (not spinning away). Recovering from a slide counts too.
TUNE.DRIFT_STEER_OK   = 0.09  -- rad (~5 deg) of front slip still fully controlled
TUNE.DRIFT_STEER_OFF  = 0.26  -- rad (~15 deg): not controlled (the steering well off the slide)
TUNE.DRIFT_GROW_OK    = 0.35  -- rad/s (~20 deg/s) the slide can grow and still be controlled
TUNE.DRIFT_GROW_OFF   = 1.0   -- rad/s (~57 deg/s): spinning away
TUNE.DRIFT_MAX_ANGLE  = 1.57  -- rad (90 deg) of slide: past this it's a spin, whatever the steering
TUNE.DRIFT_RATE_HZ    = 4     -- Hz: smoothing of the slide's growth rate
-- Understeer comes in two stages (0 .. -US_WARN_SHARE, then on to -1):
--  1. a warning as the front tyres approach their limit: front slip on its way to a road tyre's
--     peak, together with the front slipping more than the rear;
--  2. understeer proper, once the front is past its peak and clearly sliding more than the rear.
TUNE.US_WARN_SHARE    = 0.35  -- must match UNDER_WARN in app.js
TUNE.US_SLIP_START    = 0.044 -- rad (~2.5 deg) of front slip where the warning starts
TUNE.US_SLIP_FULL     = 0.122 -- rad (~7 deg, a road tyre's peak): full
TUNE.US_LEAD_START    = 0.005 -- rad (~0.3 deg) the front must slip more than the rear to count
TUNE.US_LEAD_FULL     = 0.035 -- rad (~2 deg) from which it counts fully
TUNE.US_PAST_START    = 0.122 -- rad (~7 deg) of front slip where understeer proper starts
TUNE.US_PAST_FULL     = 0.175 -- rad (~10 deg): full orange
TUNE.US_PAST_LEAD     = 0.035 -- rad (~2 deg) more than the rear where it starts ...
TUNE.US_PAST_LEAD_FULL = 0.07 -- rad (~4 deg) ... and full
TUNE.US_MIN_YAW       = 0.10  -- rad/s of rotation before it's shown at full strength
-- Grip model: how close each axle is to its grip limit, from the force it's making against what
-- its tyres would make at the same slip angle if they were still in their linear range (their
-- cornering stiffness, N/rad: BeamNG's own stability-control calibration when the vehicle has
-- one, refined while you drive gently, or learnt that way when it has none). That ratio is 1
-- while a tyre is well within its grip and falls as it nears the peak, to about the same value
-- at the peak whatever the tyre (a stiff race tyre or a soft off-road one), so the limit is
-- found for each car without fixed angles. Proximity: 0 = linear, 1 = at the peak.
TUNE.GRIP_RATIO_PEAK  = 0.42  -- force / (stiffness x slip) at a tyre's peak
TUNE.GRIP_HZ          = 6     -- smoothing of the sideways acceleration behind the force
TUNE.GRIP_SLIP_HZ     = 2.8   -- smoothing of the slip, to lag as much as the force does
TUNE.GRIP_RD_HZ       = 2.7   -- smoothing of the change of rotation, likewise
TUNE.GRIP_MIN_SPEED   = 4     -- m/s: below this the grip model stays out (fading in over the next 3 m/s)
TUNE.GRIP_MIN_SLIP    = 0.012 -- rad (~0.7 deg): below this an axle counts as well within its grip
TUNE.NEAR_ON          = 0.56  -- proximity from which an axle is near its limit (the warning) ...
TUNE.NEAR_OFF         = 0.46  -- ... and below which it's clear again
TUNE.PAST_ON          = 1.0   -- proximity from which the front is past its peak (understeer) ...
TUNE.PAST_OFF         = 0.9   -- ... and below which it's back under it
TUNE.LEAD             = 0.15  -- one axle this much nearer its limit than the other is the one that's near it
TUNE.WARN_HOLD        = 0.12  -- s an axle must stay near its limit before the warning shows
-- learning the stiffness: while cornering gently (well within the grip), steadily
TUNE.CAL_AY_LO        = 1.0   -- m/s^2 of cornering, at least ...
TUNE.CAL_AY_HI        = 2.5   -- ... and at most (about a quarter of a road car's grip: still linear)
TUNE.CAL_SLIP_HI      = 0.05  -- rad (~3 deg) of slip at most
TUNE.CAL_TAU          = 40    -- s of such driving the estimate averages over
TUNE.CAL_PRIOR_BNG    = 20    -- s of driving BeamNG's own calibration counts as
TUNE.CAL_READY        = 2.5   -- s of such cornering before a learnt (not BeamNG's) value is trusted ...
TUNE.CAL_SPREAD       = 0.0015 -- rad (~0.1 deg): ... over at least this spread of front slip
-- tests can override any of the TUNE values
if type(VGS_TUNE_OVERRIDE) == "table" then for k2, v2 in pairs(VGS_TUNE_OVERRIDE) do TUNE[k2] = v2 end end
-- ===========================================================================

local G = 9.81
local PROTOCOL = 2   -- payload version, checked by the app

local active, detail = false, false
local clock = 0               -- s, running sim clock while active
-- sending: time since the last update / layout / hub ping, layout version, layout due
local tx = { since = 0, sinceStatic = math.huge, sincePing = math.huge, lv = 0, staticDue = true,
             uiFlag = nil, keyFrames = 0 }

-- Layout, captured once (see captureLayout)
local lay = {
  wheels = nil,      -- [i] = { x, y, tyres, radius, width, steerBase, n1, n2, wheelID, pgroup }
  wait = 0,          -- s waited for the steering to centre before capturing anyway
  front = nil,       -- front axle { x, y, nodes, ring }
  rear = nil,        -- rear axle group { x, y, cut, nodes, ring }
  ext = nil,         -- whole-vehicle footprint { x0, x1, y0, y1 }
  drivetrain = nil,  -- { sources, driven, graph }
  assists = nil,     -- driving-dynamics assist controllers, when the vehicle has them
  static = nil,      -- the layout block sent to the app
  mass = nil, cgx = nil, cgy = nil,
}
local everDriven = {}   -- [i] = true once a wheel has had drive torque (fallback for odd trees)
local nodeCidByName = nil
local coupled = {}      -- [objId] = number of couplers attached to that vehicle

-- Kinematics, updated every frame
local kin = {
  latAccel = 0, gx = 0, gy = 0, gdx = 0, gdy = 0, gInit = false,
  yawRate = 0, yawFast = 0, yawSign = 1, yawCheck = 0, lastFwd = nil, lastRight = nil,
  travel = 0, rearTravel = 0,   -- rad, + = axle moving left of where the car points; continuous to +-270
  vring = nil, physYaw = nil, headYaw = nil, vel = nil, speed = 0,
}
-- Running estimates for the marker and the balance colour
local est = { kn = 0, kd = 0, cal = 1, rn = 0, rd = 0, ratio = nil, lock = LOCK_DEFAULT,
              balance = 0, frontSteer = nil, rearSteer = 0, slipF = nil, slipR = nil, shown = nil,
              drift = 0, slideRate = 0, prevSlide = nil, state = 0 }
local gm = {}   -- the grip model's state (see gripSetup)
local mark = { init = false, y = 0, d = 0, df = 0, ds = 0, s = 0 }   -- the marker's smoothing
local diag = {}         -- values behind the marker, for dumpTravel
local watch = { travel = 0, travelNext = 0, assists = false, assistValues = {} }

-- What's sent, reused every frame (nothing new is allocated per frame in steady state)
local wstate = {}       -- [i] = { grip, sliding, severity, fzAvg }
local out = { w = {}, src = {}, dg = {}, inp = {}, gf = { x = 0, y = 0 } }
local vdOut = {}        -- the numbers-mode vehicle values (sent as out.vd while numbers mode is on)
local couplerList = {}
local DETAIL_KEYS = { "fz" }

local function clamp(v, lo, hi)
  if v < lo then return lo elseif v > hi then return hi end
  return v
end

local function wrapAngle(a)   -- to -pi .. pi
  a = (a + math.pi) % (2 * math.pi)
  if a < 0 then a = a + 2 * math.pi end
  return a - math.pi
end

-- Real (wall-clock) milliseconds. os.clockhp is BeamNG's high-resolution clock in seconds; without
-- it, simulation time stands in (exact except in slow motion).
local function realMs()
  if os.clockhp then
    local ok, t = pcall(os.clockhp)
    if ok and type(t) == "number" then return t * 1000 end
  end
  return clock * 1000
end

local function round(v, digits)
  local m = 10 ^ (digits or 3)
  return math.floor(v * m + 0.5) / m
end

local function smoothstep(k) k = clamp(k, 0, 1) return k * k * (3 - 2 * k) end

-- an electrics flag: true / false, or a number above one half
local function truthy(v) return v == true or (type(v) == "number" and v > 0.5) end

-- A pedal value as BeamNG's Simple Pedals app shows it: whole percent, 0 only for exactly 0
-- and 100 only for exactly full (its smartRound), returned as 0..1.
local function pedalLevel(v)
  v = (tonumber(v) or 0) * 100
  local pct = (v >= 100) and 100 or math.floor(v + (1 - 1e-7 - v / 100))
  return clamp(pct, 0, 100) / 100
end

-- Fixed-size history of samples (tables reused in place, so no garbage per frame)
local function newRing(n)
  local r = { n = n, head = 0, count = 0, s = {} }
  for k = 1, n do r.s[k] = {} end
  return r
end
local function ringNext(r)
  r.head = r.head % r.n + 1
  if r.count < r.n then r.count = r.count + 1 end
  return r.s[r.head]
end
-- the newest sample at or before time t0, or the oldest one kept
local function ringFind(r, t0)
  local idx = r.head
  for _ = 1, r.count - 1 do
    if r.s[idx].t <= t0 then return r.s[idx] end
    idx = (idx - 2) % r.n + 1
  end
  return r.s[idx]
end

local function basis()
  local fwd   = obj:getDirectionVector():normalized()
  local up    = obj:getDirectionVectorUp():normalized()
  local right = fwd:cross(up):normalized()
  return fwd, right
end

local function wheelCount()
  if not wheels or not wheels.wheels then return 0 end
  return tableSizeC(wheels.wheels)
end

local function forEachWheel(fn)
  for i = 0, wheelCount() - 1 do
    local w = wheels.wheels[i]
    if w and w.node1 and w.node2 then fn(i, w) end
  end
end

-- Yaw of a wheel's axle in the vehicle's horizontal plane (radians, + = turned left), plus the
-- hub midpoint relative to the vehicle's reference node.
local function axleYaw(w, fwd, right)
  local p1 = obj:getNodePosition(w.node1)
  local p2 = obj:getNodePosition(w.node2)
  local axle = p2 - p1
  local f, r = axle:dot(fwd), axle:dot(right)
  if r < 0 then f, r = -f, -r end   -- node order differs between left and right wheels
  return math.atan2(f, r), p1, p2
end

-- ===== Drivetrain map ======================================================
-- Every power source (combustion engine, electric motor, including modded ones), where it sits
-- and which wheels it drives, from the powertrain device tree. Field names vary between
-- versions and mods, so every lookup is defensive.

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

local function nodesCentroid(list, fwd, right)
  if type(list) ~= "table" then return nil end
  local sx, sy, n = 0, 0, 0
  for _, ref in pairs(list) do
    local cid = resolveNode(ref)
    if cid then
      local ok, p = pcall(obj.getNodePosition, obj, cid)
      if ok and p then sx, sy, n = sx + p:dot(right), sy + p:dot(fwd), n + 1 end
    end
  end
  if n == 0 then return nil end
  return sx / n, sy / n
end

-- centroid of the nodes whose group name contains one of `includes` and none of `excludes`
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
          if hit then list[#list + 1] = node.cid or cid; break end
        end
      end
    end
  end
  return nodesCentroid(list, fwd, right)
end

local function devType(d) return type(d.type) == "string" and d.type or "" end

local function isPowerSource(d)
  local tl = devType(d):lower()
  if tl:find("starter") then return false end
  if type(d.deviceCategories) == "table" and d.deviceCategories.engine then return true end
  return tl:find("engine$") ~= nil or tl:find("motor$") ~= nil
end

-- The wheel a powertrain device drives, if any: a wheel-axle shaft names it (connectedWheel),
-- and newer trees also have a "wheel" device per wheel (spindleRL -> RL).
local function wheelIndexFor(dev, wheelIdxByName)
  local cands = { dev.connectedWheel, dev.wheelName }
  if type(dev.wheel) == "table" then cands[#cands + 1] = dev.wheel.name end
  if devType(dev) == "wheel" and type(dev.name) == "string" then
    cands[#cands + 1] = dev.name:match("^spindle_?(.+)$") or dev.name:match("^wheel_?(.+)$") or dev.name
  end
  for _, c in ipairs(cands) do
    if type(c) == "string" and wheelIdxByName[c] then return wheelIdxByName[c] end
  end
  return nil
end

local function collectDrivenWheels(device, wheelIdxByName, outSet, visited, depth)
  if depth > 64 or visited[device] then return end
  visited[device] = true
  local wi = wheelIndexFor(device, wheelIdxByName)
  if wi then outSet[wi] = true end
  if type(device.children) == "table" then
    for _, child in pairs(device.children) do
      if type(child) == "table" then collectDrivenWheels(child, wheelIdxByName, outSet, visited, depth + 1) end
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
-- Engine/motor -> gearbox -> differentials -> wheels, the way BeamNG's PowerTrain debug app
-- reads the device tree, keeping only what the VGS draws. Nodes are in pre-order (parents
-- first); p = parent index (0 = root). Everything between two nodes is a shaft ("link").
--   "src"    combustion engine / electric motor (roots; or inline, for a motor partway down
--            another source's driveline, as in some hybrids)
--   "gb"     the first gearbox on the way to the wheels (any *Gearbox type)
--   "diff"   differential (any type) or split shaft
--   "wheel"  a wheel: the shaft that names it, or its "wheel" (spindle) device
--   on a link: "dog" = a shaft that can be disconnected (4WD engage, locking hubs, axle
--   disconnects). Everything else (clutches, torque converters, plain shafts, dually diffs, ...)
--   is passed through. Devices that never reach a wheel (hydraulic pumps, power take-offs)
--   are dropped.
local unpack = unpack or table.unpack

local function isGearbox(d) return devType(d):lower():find("gearbox$") ~= nil end

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

-- open / lsd / locked, from the current mode first (a lockable diff switches modes), as
-- BeamNG's differential.lua runs it:
--  * locked and dually (duals ride on a locked diff) -> locked
--  * open and torqueVectoring (both use the open diff's torque split) -> open
--  * lsd and viscous -> lsd
--  * activeLock: a clutch the car's electronics clamp, activeLockCoef 0..1 -> shown live
-- A split shaft (transfer case) is locked or viscous by its splitType.
local ACTIVE_LOCKED, ACTIVE_OPEN = 0.95, 0.05
local DIFF_CODE = { open = 1, lsd = 2, locked = 3 }
local function diffState(d)
  local mode = type(d.mode) == "string" and d.mode:lower() or ""
  if mode == "locked" or mode == "dually" then return "locked" end
  if mode == "open" or mode == "torquevectoring" then return "open" end
  if mode == "lsd" or mode == "viscous" then return "lsd" end
  if mode == "activelock" then
    local c = tonumber(d.activeLockCoef) or 0
    if c >= ACTIVE_LOCKED then return "locked" end
    return c > ACTIVE_OPEN and "lsd" or "open"
  end
  if type(d.splitType) == "string" then
    return d.splitType:lower() == "locked" and "locked" or "lsd"
  end
  if type(d.visualType) ~= "string" and type(d.diffType) ~= "string" and devType(d) == "differential" then
    return "open"   -- no type given: BeamNG's default differential is open
  end
  local kind = diffKind(d):lower()
  if kind:find("locked") then return "locked" end
  if kind:find("open") then return "open" end
  return "lsd"
end

local function diffTypeName(d) return (diffKind(d):lower():gsub("^differential_?", "")) end

-- no drive through it: switched off (mode disconnected) or broken (no torque passes)
local function isDisconnected(d)
  return d.isBroken == true or (type(d.mode) == "string" and d.mode:lower() == "disconnected")
end

-- A shaft that can really be disconnected. Every shaft reports mode "connected", so it must
-- also say it can disconnect (canDisconnect, or a mode list with "disconnected"), or be
-- disconnected right now.
local function modeListHasDisconnect(list)
  if type(list) ~= "table" then return false end
  for k, m in pairs(list) do
    if (type(m) == "string" and m:lower() == "disconnected") or (type(k) == "string" and k:lower() == "disconnected") then
      return true
    end
  end
  return false
end

local function canDisconnect(dev)
  if type(dev.mode) == "string" and dev.mode:lower() == "disconnected" then return true end
  if dev.canDisconnect == true or dev.canDisconnect == 1 then return true end
  local jd = type(dev.jbeamData) == "table" and dev.jbeamData or {}
  if jd.canDisconnect == true or jd.canDisconnect == 1 then return true end
  return modeListHasDisconnect(dev.availableModes) or modeListHasDisconnect(dev.modes)
      or modeListHasDisconnect(jd.availableModes) or modeListHasDisconnect(jd.modes)
end

local function childList(dev)
  local list = {}
  if type(dev.children) == "table" then
    for _, c in pairs(dev.children) do if type(c) == "table" then list[#list + 1] = c end end
  end
  return list
end

local function buildDriveGraph(sources, wheelIdxByName, fwd, right)
  local nodes, visited, srcIndex = {}, {}, {}
  for si, s in ipairs(sources) do if s.dev then srcIndex[s.dev] = si end end
  local function add(n) nodes[#nodes + 1] = n; return #nodes end
  local function extend(link, dev)
    local nl = { cps = { unpack(link.cps) }, path = { unpack(link.path) } }
    nl.path[#nl.path + 1] = dev
    if type(dev.mode) == "string" and canDisconnect(dev) then nl.cps[#nl.cps + 1] = { kind = "dog", dev = dev } end
    return nl
  end
  local function newLink() return { cps = {}, path = {} } end

  local function walk(dev, parent, link, depth, sawGearbox)
    if depth > 64 or visited[dev] then return end
    visited[dev] = true
    local wi = wheelIndexFor(dev, wheelIdxByName)
    if wi then
      local l = extend(link, dev)
      add({ k = "wheel", w = wi, p = parent, cps = l.cps, path = l.path, name = dev.name })
      return
    end
    local here, childLink, sawGb = parent, nil, sawGearbox
    if srcIndex[dev] then
      -- a motor partway down another source's driveline: drawn as its own source, fed by it
      here = add({ k = "src", si = srcIndex[dev], p = parent, cps = link.cps, path = link.path, dev = dev, name = dev.name })
      childLink, sawGb = newLink(), false
    elseif not sawGearbox and isGearbox(dev) then
      here = add({ k = "gb", sub = devType(dev), p = parent, cps = link.cps, path = link.path, dev = dev, name = dev.name })
      childLink, sawGb = newLink(), true
    elseif isDifferential(dev) and not isDually(dev) then
      here = add({ k = "diff", p = parent, cps = link.cps, path = link.path, dev = dev, name = dev.name })
      childLink = newLink()
    else
      childLink = extend(link, dev)
    end
    for _, c in ipairs(childList(dev)) do walk(c, here, childLink, depth + 1, sawGb) end
  end

  -- true roots first, so a motor fed by another source is reached from it rather than drawn
  -- as a separate, unconnected root
  local order = {}
  for si, s in ipairs(sources) do if s.dev then order[#order + 1] = si end end
  table.sort(order, function(a, b)
    local pa = type(sources[a].dev.parent) == "table" and 1 or 0
    local pb = type(sources[b].dev.parent) == "table" and 1 or 0
    if pa ~= pb then return pa < pb end
    return a < b
  end)
  for _, si in ipairs(order) do
    local s = sources[si]
    if not visited[s.dev] then
      visited[s.dev] = true
      local root = add({ k = "src", si = si, p = 0, cps = {}, path = {}, name = s.dev.name, dev = s.dev })
      for _, c in ipairs(childList(s.dev)) do walk(c, root, newLink(), 1, false) end
    end
  end

  -- prune branches that never reach a wheel
  local reaches = {}
  for idx = #nodes, 1, -1 do
    local n = nodes[idx]
    if n.k == "wheel" then reaches[idx] = true end
    if reaches[idx] and n.p > 0 then reaches[n.p] = true end
  end
  local keep, newIndex = {}, {}
  for idx, n in ipairs(nodes) do
    if (n.k == "src" and n.p == 0) or reaches[idx] then
      keep[#keep + 1] = n; newIndex[idx] = #keep
      n.p = n.p > 0 and (newIndex[n.p] or 0) or 0
    end
  end
  nodes = keep

  -- the first gearbox under each source, for traction control acting on it (some hybrids)
  for _, n in ipairs(nodes) do
    if n.k == "gb" then
      local m = nodes[n.p]
      while m and m.k ~= "src" do m = nodes[m.p] end
      if m and sources[m.si] and not sources[m.si].gbDev then sources[m.si].gbDev = n.dev end
    end
  end

  -- physical positions where the vehicle's structure names them; the app places the rest
  local gx, gy = groupCentroid(fwd, right, { "transmission", "gearbox", "transaxle" }, { "mount", "tunnel", "cover", "cooler" })
  local tx, ty = groupCentroid(fwd, right, { "transfercase", "transfer_case" }, { "mount", "cover" })
  local gbDone, tcDone = false, false
  local wheelsUnder = {}
  for idx = #nodes, 1, -1 do
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
        if lay.wheels[w] then y0, y1 = math.min(y0, lay.wheels[w].y), math.max(y1, lay.wheels[w].y) end
      end
      if y1 - y0 > 0.35 then n.gx, n.gy, tcDone = tx, ty, true end   -- spans axles: centre diff
    end
  end
  return nodes
end

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
      local isElectric = devType(d):lower():find("electric") ~= nil
      local x, y = sourcePosition(d, fwd, right)
      local estimated = false
      if not x and not isElectric and not usedEngineGroup then
        x, y = groupCentroid(fwd, right, { "engine" }, { "bay", "mount", "hood", "cover" })
        usedEngineGroup = x ~= nil
      end
      if not x then   -- last resort: centre of the wheels it drives
        estimated = true
        local sx, sy, n = 0, 0, 0
        for _, i in ipairs(wheelList) do
          if lay.wheels[i] then sx, sy, n = sx + lay.wheels[i].x, sy + lay.wheels[i].y, n + 1 end
        end
        if n > 0 then x, y = sx / n, sy / n end
      end
      if x then
        result.sources[#result.sources + 1] = { x = x, y = y, kind = isElectric and "ev" or "ice", est = estimated, wheels = wheelList, dev = d }
      end
    end
  end
  -- Only sources that drive wheels: trailers and equipment can carry motors for hydraulics,
  -- winches or landing gear. If nothing drives wheels (odd layout), keep the combustion engines.
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

-- ===== Tyres per wheel =====================================================
-- A dual pair can reach us as two wheels (the app lays them out), or as ONE wheel standing in
-- for both. For the second case: an explicit dual flag, a tyre mesh named "dual" on this
-- wheel's node groups, or a truck-sized tyre much wider than it is tall.
local DUAL_WIDTH_RATIO = 1.0
local DUAL_MIN_RADIUS  = 0.42

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
      for name in pairs(groupSet(fb.group, fb["[group]"])) do
        if groups[name] then return true end
      end
    end
  end
  return false
end

-- tyre count, wheelOffset (m), reason, radius, width
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
  -- a wheel with no tyre (the Pigeon's stabiliser wheels): draw it at the hub's size
  local hasTire = w.hasTire
  if hasTire == nil then hasTire = d.hasTire end
  if hasTire == false or hasTire == 0 then
    return 1, offset, "hub only, no tyre", num("hubRadius") or radius, num("hubWidth") or tireWidth
  end
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

-- the layout block the app draws from (sent with the frames; see send)
local function buildStatic(graph)
  local st = { w = {}, src = {}, dt = {} }
  for i = 0, wheelCount() - 1 do
    local L, w = lay.wheels[i], wheels.wheels[i]
    if L then
      st.w[#st.w + 1] = {
        i = i, n = w.name,
        nt = L.tyres or 1,                              -- tyres this wheel stands for (2 = dual pair)
        rd = L.radius and round(L.radius, 3) or nil,    -- tyre radius (m)
        wd = L.width and round(L.width, 3) or nil,      -- width of each tyre (m)
        x = round(L.x, 3), y = round(L.y, 3),           -- metres right / forward of the reference node
      }
    end
  end
  for _, s in ipairs(lay.drivetrain.sources) do
    st.src[#st.src + 1] = { x = round(s.x, 3), y = round(s.y, 3), k = s.kind, e = s.est and 1 or 0, w = s.wheels }
  end
  for _, n in ipairs(graph) do
    local cps = {}
    for _, c in ipairs(n.cps or {}) do cps[#cps + 1] = { t = c.kind } end
    st.dt[#st.dt + 1] = {
      k = n.k, p = n.p, w = n.w, si = n.si and (n.si - 1) or nil, sub = n.sub,
      dty = (n.k == "diff" and n.dev) and diffTypeName(n.dev) or nil,
      cp = (#cps > 0) and cps or nil,
      gx = n.gx and round(n.gx, 3) or nil, gy = n.gy and round(n.gy, 3) or nil,
    }
  end
  if lay.ext then
    st.ext = { x0 = round(lay.ext.x0, 2), x1 = round(lay.ext.x1, 2), y0 = round(lay.ext.y0, 2), y1 = round(lay.ext.y1, 2) }
  end
  if lay.cgy then st.cg = { x = round(lay.cgx, 3), y = round(lay.cgy, 3) } end
  if lay.mass then st.m = math.floor(lay.mass + 0.5) end
  if #st.w == 0 then st.w = nil end
  return st
end

local function captureLayout(fwd, right, steeringCentred)
  lay.wheels, wstate = {}, {}
  forEachWheel(function(i, w)
    local yaw, p1, p2 = axleYaw(w, fwd, right)
    local mid = (p1 + p2) * 0.5
    local okT, tyres, offset, _, radius, width = pcall(tyreInfo, i, w)
    if not okT then tyres, offset, radius, width = 1, 0, nil, nil end
    local axle = p2 - p1
    local axleLen = axle:length()
    local x = mid:dot(right)
    if offset ~= 0 and axleLen > 1e-3 then x = x + offset * axle:dot(right) / axleLen end
    radius = radius or ((type(w.radius) == "number" and w.radius > 0.05) and w.radius or nil)
    width = width or ((axleLen > 0.02) and axleLen or nil)
    if width and tyres > 1 and radius and width > radius * 0.9 then width = width / tyres * 0.92 end
    local pg = nil
    if w.pressureGroup and v and v.data and type(v.data.pressureGroups) == "table" then pg = v.data.pressureGroups[w.pressureGroup] end
    lay.wheels[i] = {
      x = x, y = mid:dot(fwd), tyres = tyres, radius = radius, width = width,
      steerBase = steeringCentred and yaw or 0,   -- removes static toe so straight-ahead reads 0
      centred = steeringCentred,                  -- false: snap steerBase the first time the steering is centred
      n1 = w.node1, n2 = w.node2, wheelID = w.wheelID, pgroup = pg,
    }
    wstate[i] = { grip = 0, sliding = false, severity = 0, fzAvg = math.max(w.downForceRaw or w.downForce or 0, 0) }
  end)

  -- The frontmost axle (where the marker is measured) and the wheels in the rear half (the
  -- middle of a tandem), for the balance. Each keeps its hub nodes and their recent positions.
  lay.front, lay.rear = nil, nil
  local maxY, minY = -math.huge, math.huge
  for _, L in pairs(lay.wheels) do maxY = math.max(maxY, L.y); minY = math.min(minY, L.y) end
  if maxY > -math.huge then
    local sx, sy, n, nodes = 0, 0, 0, {}
    for _, L in pairs(lay.wheels) do
      if L.y > maxY - 0.3 then
        sx, sy, n = sx + L.x, sy + L.y, n + 1
        nodes[#nodes + 1] = L.n1; nodes[#nodes + 1] = L.n2
      end
    end
    lay.front = { x = sx / n, y = sy / n, nodes = nodes, ring = newRing(64) }
    if maxY - minY > 0.5 then
      local cut = (maxY + minY) / 2
      sx, sy, n, nodes = 0, 0, 0, {}
      for _, L in pairs(lay.wheels) do
        if L.y < cut then
          sx, sy, n = sx + L.x, sy + L.y, n + 1
          nodes[#nodes + 1] = L.n1; nodes[#nodes + 1] = L.n2
        end
      end
      if n > 0 then lay.rear = { x = sx / n, y = sy / n, cut = cut, nodes = nodes, ring = newRing(64) } end
    end
  end

  -- footprint of the whole vehicle, its mass and centre of gravity
  lay.ext, lay.mass, lay.cgx, lay.cgy = nil, nil, nil, nil
  if v and v.data and type(v.data.nodes) == "table" then
    local x0, x1, y0, y1, mass = math.huge, -math.huge, math.huge, -math.huge, 0
    for cid, node in pairs(v.data.nodes) do
      local id = type(node) == "table" and (node.cid or cid) or nil
      if type(id) == "number" then
        local okP, p = pcall(obj.getNodePosition, obj, id)
        if okP and p then
          local x, y = p:dot(right), p:dot(fwd)
          x0, x1 = math.min(x0, x), math.max(x1, x)
          y0, y1 = math.min(y0, y), math.max(y1, y)
        end
        if obj.getNodeMass then
          local okM, m = pcall(obj.getNodeMass, obj, id)
          if okM and type(m) == "number" then mass = mass + m end
        end
      end
    end
    if x0 < x1 and y0 < y1 then lay.ext = { x0 = x0, x1 = x1, y0 = y0, y1 = y1 } end
    if mass > 1 then lay.mass = mass end
  end
  if obj.calcCenterOfGravity then
    local okC, cg = pcall(obj.calcCenterOfGravity, obj)
    if okC and type(cg) ~= "number" and cg then
      local rel = cg - obj:getPosition()
      lay.cgx, lay.cgy = rel:dot(right), rel:dot(fwd)
    end
  end

  -- BeamNG's driving-dynamics assists, when the vehicle has them (named as in its jbeam)
  lay.assists = {}
  if controller and controller.getController then
    for key, name in pairs({ tc = "tractionControl", yc = "yawControl", brake = "brakeControl", motor = "motorTorqueControl" }) do
      local okC, c = pcall(controller.getController, name)
      if okC and type(c) == "table" and (c.isActing ~= nil or c.isActingAsYC ~= nil) then lay.assists[key] = c end
    end
  end

  local ok, dt = pcall(mapDrivetrain, fwd, right)
  lay.drivetrain = ok and dt or { sources = {}, driven = {}, graph = {} }
  if not ok then log('W', 'vgsTelemetry', 'drivetrain map failed: ' .. tostring(dt)) end

  local okS, st = pcall(buildStatic, lay.drivetrain.graph or {})
  lay.static = okS and st or { w = {} }
  if not okS then log('W', 'vgsTelemetry', 'layout block failed: ' .. tostring(st)) end
  tx.lv = tx.lv + 1
  tx.staticDue, tx.keyFrames = true, 3   -- send the new layout with the next few updates
  -- per-wheel output tables, reused from here on
  out.w, out.src, out.dg = {}, {}, {}
  for i = 0, wheelCount() - 1 do if lay.wheels[i] then out.w[#out.w + 1] = { i = i } end end
  for k = 1, #lay.drivetrain.sources do out.src[k] = {} end
  for k = 1, #(lay.drivetrain.graph or {}) do out.dg[k] = 0 end
end

local function resetState()
  lay.wheels, lay.static, lay.drivetrain, lay.front, lay.rear, lay.wait = nil, nil, nil, nil, nil, 0
  everDriven, nodeCidByName, wstate = {}, nil, {}
  kin.latAccel, kin.gx, kin.gy, kin.gdx, kin.gdy, kin.gInit = 0, 0, 0, 0, 0, false
  kin.yawRate, kin.yawCheck, kin.lastFwd, kin.lastRight, kin.travel, kin.rearTravel = 0, 0, nil, nil, 0, 0
  kin.yawFast, mark.init = 0, false
  kin.vring = newRing(128)
  est.kn, est.kd, est.cal, est.rn, est.rd, est.ratio, est.lock = 0, 0, 1, 0, 0, nil, LOCK_DEFAULT
  est.balance, est.frontSteer, est.rearSteer, est.slipF, est.slipR, est.shown = 0, nil, 0, nil, nil, nil
  est.drift, est.slideRate, est.prevSlide, est.state = 0, 0, nil, 0
  for k in pairs(gm) do gm[k] = nil end
  out.inp, out.vd = {}, nil
  for k in pairs(vdOut) do vdOut[k] = nil end
  tx.since, tx.sinceStatic, tx.sincePing, tx.staticDue = 0, math.huge, math.huge, true
end

-- ===== Per-frame update ====================================================

-- G-force: least-squares slope of the velocity over GF_WINDOW, then a One Euro filter.
local function lpAlpha(cutoff, dt) return 1 / (1 + 1 / (2 * math.pi * cutoff * dt)) end
local function updateAccel(dt, vel, fwd, right)
  local r = kin.vring
  local s = ringNext(r)
  s.t, s.x, s.y, s.z = clock, vel.x, vel.y, vel.z
  -- least-squares slope of each velocity component against time over the window
  local t0 = clock - GF_WINDOW
  local n, st, sx, sy, sz = 0, 0, 0, 0, 0
  local idx = r.head
  for _ = 1, r.count do
    local q = r.s[idx]
    if q.t < t0 - 1e-9 then break end
    n, st, sx, sy, sz = n + 1, st + q.t, sx + q.x, sy + q.y, sz + q.z
    idx = (idx - 2) % r.n + 1
  end
  if n < 3 then return end
  local tm, xm, ym, zm = st / n, sx / n, sy / n, sz / n
  local stt, stx, sty, stz = 0, 0, 0, 0
  idx = r.head
  for _ = 1, n do
    local q = r.s[idx]
    local d = q.t - tm
    stt, stx, sty, stz = stt + d * d, stx + d * (q.x - xm), sty + d * (q.y - ym), stz + d * (q.z - zm)
    idx = (idx - 2) % r.n + 1
  end
  if stt < 1e-9 then return end
  local ax, ay, az = stx / stt, sty / stt, stz / stt
  local aLat = ax * right.x + ay * right.y + az * right.z
  local aLon = ax * fwd.x + ay * fwd.y + az * fwd.z
  kin.latAccel = kin.latAccel + (aLat - kin.latAccel) * clamp(dt * ACCEL_SMOOTH_HZ, 0, 1)
  kin.aLatRaw = aLat   -- the grip model's own, less smoothed (see gripStep)
  local x, y = aLat / G, aLon / G
  if not kin.gInit then kin.gx, kin.gy, kin.gInit = x, y, true return end
  local ad = lpAlpha(GF_D_CUTOFF, dt)
  kin.gdx = kin.gdx + ((x - kin.gx) / dt - kin.gdx) * ad
  kin.gdy = kin.gdy + ((y - kin.gy) / dt - kin.gdy) * ad
  local a = lpAlpha(GF_MIN_CUTOFF + GF_BETA * math.sqrt(kin.gdx * kin.gdx + kin.gdy * kin.gdy), dt)
  kin.gx = kin.gx + (x - kin.gx) * a
  kin.gy = kin.gy + (y - kin.gy) * a
end

-- Yaw rate (+ = turning left) from the physics (the value BeamNG's own ESC uses), checked
-- against the change in heading for its sign; the heading change is the fallback.
local function updateYaw(dt, fwd, right)
  local headYaw = nil
  if kin.lastFwd then headYaw = math.atan2(-fwd:dot(kin.lastRight), fwd:dot(kin.lastFwd)) / dt end
  kin.lastFwd, kin.lastRight = fwd, right
  local physYaw = nil
  if obj.getYawAngularVelocity then
    local okY, y = pcall(obj.getYawAngularVelocity, obj)
    if okY and type(y) == "number" and y == y then physYaw = -y end
  end
  local raw = headYaw
  if physYaw then
    if headYaw then
      kin.yawCheck = kin.yawCheck + (kin.yawSign * physYaw * headYaw - kin.yawCheck) * clamp(dt * 0.5, 0, 1)
      if kin.yawCheck < -0.01 then kin.yawSign, kin.yawCheck = -kin.yawSign, -kin.yawCheck end
    end
    raw = kin.yawSign * physYaw
  end
  if raw then
    kin.yawRate = kin.yawRate + (raw - kin.yawRate) * clamp(dt * YAW_SMOOTH_HZ, 0, 1)
    if TUNE.MARK_YAW_HZ > 0 then kin.yawFast = kin.yawFast + (raw - kin.yawFast) * lpAlpha(TUNE.MARK_YAW_HZ, dt)
    else kin.yawFast = raw end
  end
  kin.physYaw, kin.headYaw = physYaw, headYaw
end

-- Direction an axle is moving (+ = left of where the car points), all the way round: how far
-- its hub nodes moved over the last TRAVEL_WINDOW against the car's heading over that time
-- (averaging out the hubs' vibration). If the nodes can't be read: the body's velocity plus
-- the yaw rate's share at the axle.
local function hubMotion(axle, origin, fwd, right)
  local nodes = axle.nodes
  if not nodes or #nodes == 0 then return nil end
  local sx, sy, sz = 0, 0, 0
  for _, cid in ipairs(nodes) do
    local q = obj:getNodePosition(cid)
    sx, sy, sz = sx + q.x, sy + q.y, sz + q.z
  end
  local n = #nodes
  local s = ringNext(axle.ring)
  s.t = clock
  s.px, s.py, s.pz = origin.x + sx / n, origin.y + sy / n, origin.z + sz / n
  s.fx, s.fy, s.fz, s.rx, s.ry, s.rz = fwd.x, fwd.y, fwd.z, right.x, right.y, right.z
  local o = ringFind(axle.ring, clock - TRAVEL_WINDOW)
  local span = clock - o.t
  if span < TRAVEL_WINDOW * 0.3 then return nil end
  local vx, vy, vz = (s.px - o.px) / span, (s.py - o.py) / span, (s.pz - o.pz) / span
  local fx, fy, fz = s.fx + o.fx, s.fy + o.fy, s.fz + o.fz   -- heading across the window
  local rx, ry, rz = s.rx + o.rx, s.ry + o.ry, s.rz + o.rz
  local fl, rl = math.sqrt(fx * fx + fy * fy + fz * fz), math.sqrt(rx * rx + ry * ry + rz * rz)
  if fl < 1e-6 or rl < 1e-6 then return nil end
  return (vx * rx + vy * ry + vz * rz) / rl, (vx * fx + vy * fy + vz * fz) / fl
end

local function axleTravel(axle, current, tag, vel, origin, fwd, right, k)
  local yx = vel:dot(right) - kin.yawRate * axle.y   -- from the yaw rate: sideways, + = right
  local yy = vel:dot(fwd) + kin.yawRate * axle.x     -- forwards
  local ok, vx, vy = pcall(hubMotion, axle, origin, fwd, right)
  if not ok then vx, vy = nil, nil end
  diag[tag .. "Yaw"] = math.atan2(-yx, yy)
  diag[tag .. "Hub"] = vx and math.atan2(-vx, vy) or nil
  if not vx then vx, vy = yx, yy end
  if vx * vx + vy * vy < 0.09 then return current end   -- barely moving: keep the last value
  -- step the short way round, so the angle stays continuous past +-180
  local a = current + wrapAngle(math.atan2(-vx, vy) - current) * k
  if a > 1.5 * math.pi then a = a - 2 * math.pi elseif a < -1.5 * math.pi then a = a + 2 * math.pi end
  return a
end

-- Driver-assist context for this frame. Two systems are covered:
--  * the classic ESC script: electrics absActive / tcsActive / escActive;
--  * BeamNG's driving-dynamics electronics (the Vivace and others): tractionControl and
--    yawControl say whether they're acting; motorTorqueControl (power) and brakeControl
--    (brakes) carry it out, each with isActingAsTC / isActingAsYC / isActingAsABS.
-- Only assists the vehicle reports having are shown. Nothing is held: each update is that moment.
local ax = {}
local function updateAssists(ev)
  local dd = lay.assists or {}
  local function present(hasKey, activeKey)
    if ev[hasKey] ~= nil then return truthy(ev[hasKey]) end
    return ev[activeKey] ~= nil
  end
  local function acting(c, key) return c ~= nil and c[key] == true end
  ax.hasABS = truthy(ev.hasABS)
  ax.hasTCS = present("hasTCS", "tcsActive") or dd.tc ~= nil
  ax.hasESC = present("hasESC", "escActive") or dd.yc ~= nil
  ax.brakeIn = clamp(tonumber(ev.brake) or 0, 0, 1)
  ax.parkIn = clamp(tonumber(ev.parkingbrake) or 0, 0, 1)
  ax.brakeOn = ax.brakeIn > 0
  -- electrics.abs is the dash light's blink; absActive is the real state. The per-wheel check
  -- also catches the driving-dynamics ABS, which sets neither.
  ax.absOn = ax.hasABS and ax.brakeOn and truthy(ev.absActive)
  ax.tcsOn = ax.hasTCS and (truthy(ev.tcsActive) or acting(dd.tc, "isActing"))
  ax.escOn = ax.hasESC and (truthy(ev.escActive) or acting(dd.yc, "isActing"))
  -- power cut by an assist: traction control, or ESC working through the engine
  ax.powerCut = ax.tcsOn or (ax.hasESC and acting(dd.motor, "isActingAsYC"))
  -- ESC braking wheels: the classic script, or the driving-dynamics brake part doing it for ESC
  ax.escBraking = ax.escOn and (dd.brake == nil or acting(dd.brake, "isActingAsYC"))
  -- Traction control braking a spinning wheel (it only cuts power once every driven wheel
  -- spins, so this is often all it's doing). Classic: tcsActive while ESC isn't acting.
  -- Driving dynamics: the brake part acting for it, or the supervisor while that part brakes.
  ax.tcBraking = ax.hasTCS and ((dd.brake == nil and ax.tcsOn and not ax.escOn)
    or (dd.brake ~= nil and (acting(dd.brake, "isActingAsTC") or acting(dd.tc, "isActing"))))
  ax.drivingDynamics = dd.tc ~= nil or dd.yc ~= nil or dd.brake ~= nil or dd.motor ~= nil
  ax.throttleOn = (tonumber(ev.throttle) or 0) > 0.01
  ax.tcCause = dd.motor == nil or acting(dd.motor, "isActingAsTC") or acting(dd.tc, "isActing")
end

-- Traction control cutting power, per engine or motor. Each multiplies its throttle by a factor:
-- the electrics value it names (electricsThrottleFactorName) if set, else its own
-- throttleFactor; some hybrids apply it to their gearbox instead. Only traction control and
-- ESC lower it: the classic script snaps it back to exactly 1 under a 5 % cut, and the
-- driving-dynamics motorTorqueControl sets the lower of its TC and ESC factors (so it only
-- counts as traction control while that part says so). Only while on the throttle.
local srcCut, cutWheel = {}, {}
local function updateSourceCuts(ev)
  for k in pairs(cutWheel) do cutWheel[k] = nil end
  ax.anyCut, ax.minFactor = false, 1
  for si, s in ipairs(lay.drivetrain.sources) do
    local d, factor = s.dev, 1
    if type(d) == "table" then
      local name = d.electricsThrottleFactorName
      factor = (type(name) == "string" and tonumber(ev[name])) or tonumber(d.throttleFactor) or 1
      if type(s.gbDev) == "table" and tonumber(s.gbDev.throttleFactor) then
        factor = math.min(factor, tonumber(s.gbDev.throttleFactor))
      end
    end
    local cut = ax.hasTCS and ax.throttleOn and ax.tcCause and factor < 0.999
    if cut then
      ax.anyCut = true
      for _, wi in ipairs(s.wheels or {}) do cutWheel[wi] = true end
    end
    ax.minFactor = math.min(ax.minFactor, factor)
    local c = srcCut[si] or {}
    c.factor, c.cut = factor, cut
    srcCut[si] = c
  end
end

-- Live drive graph: each differential's lock state, disconnected or broken shafts, and which
-- wheels are connected to a power source. dg[k] packs node k's state into one number:
-- bits 0-1 diff state (1 open, 2 lsd, 3 locked), bit 2 link disconnected, bit 3+j the j-th
-- disconnectable shaft on the link is open.
local liveDriven, live = {}, {}
local function updateGraph()
  local graph = lay.drivetrain.graph or {}
  for k in pairs(liveDriven) do liveDriven[k] = nil end
  for idx, n in ipairs(graph) do
    local dc, code = false, 0
    for j, c in ipairs(n.cps or {}) do
      if isDisconnected(c.dev) then dc = true; code = code + 2 ^ (2 + j) end
    end
    for _, d in ipairs(n.path or {}) do if d.isBroken == true then dc = true end end
    if n.dev and n.dev.isBroken == true then dc = true end
    if dc then code = code + 4 end
    if n.k == "diff" and n.dev then code = code + DIFF_CODE[diffState(n.dev)] end
    live[idx] = (n.k == "src") or (live[n.p] and not dc) or false
    if n.k == "wheel" and live[idx] then liveDriven[n.w] = true end
    out.dg[idx] = code
  end
  return #graph > 0
end

local tcBraked = {}
local function updateWheels(dt, fwd, right, speed, ev, hasGraph)
  local throttle = ev.throttle or 0
  local gripK = 1 - (1 - GRIP_SMOOTHING) ^ (30 * dt)
  local loadK = clamp(LOAD_SMOOTH_HZ * dt, 0, 1)
  local steerInAbs = math.abs(tonumber(ev.steering_input) or 0)
  local centreNow = steerInAbs < CENTRE_INPUT and math.abs(kin.yawRate) < 0.03 and speed > 3
  -- a layout captured with the steering turned: take the straight-ahead reference the first
  -- time the steering is centred with the car not cornering (standing, or driving straight)
  local snapNow = steerInAbs < CENTRE_INPUT and (speed < 3 or math.abs(kin.yawRate) < 0.03)
  local centreK = clamp(dt / TUNE.CENTRE_TAU, 0, 1)
  local fSum, fN, rSum, rN = 0, 0, 0, 0
  for k in pairs(tcBraked) do tcBraked[k] = nil end
  local front, rear = lay.front, lay.rear
  for _, o in ipairs(out.w) do
    local i = o.i
    local w, L, S = wheels.wheels[i], lay.wheels[i], wstate[i]
    if w and L and S then
      local fz       = w.downForceRaw or w.downForce or 0
      local radius   = (w.radius and w.radius > 0.05) and w.radius or 0.3
      local drive    = w.propulsionTorque or 0
      local brake    = math.abs(w.brakingTorque or 0)
      local brakeMax = w.brakeTorque or 0
      local slip     = math.abs(w.lastSlip or 0)
      local broken   = w.isBroken and true or false
      -- For the grip and slide: no load below MIN_LOAD, frame by frame (as always).
      -- Shown off the ground (blue) only once the wheel has carried less than that for a while:
      -- on a rough road a wheel is unloaded for a frame or two on every bump without leaving the
      -- ground in any way that matters. Back on the ground as soon as it carries load again.
      local unloaded = fz < MIN_LOAD
      if unloaded then S.airT = (S.airT or 0) + dt else S.airT = 0 end
      if unloaded and S.airT >= AIR_SHOW_AFTER then S.air = true
      elseif fz > MIN_LOAD * 2 then S.air = false end
      local airborne = broken or unloaded
      -- How near the ground it is to leaving it (0 = normal, 1 = about to): its load, smoothed a
      -- little so a bump doesn't flash it, against its normal load (followed slowly while the
      -- wheel is properly loaded). It starts below LIGHT_FRAC of the normal load.
      S.fzLp = S.fzLp and (S.fzLp + (fz - S.fzLp) * lpAlpha(LIGHT_HZ, dt)) or fz
      if not S.fzRef then S.fzRef = math.max(fz, MIN_LOAD * 4)
      elseif fz > S.fzRef * 0.5 then S.fzRef = math.max(S.fzRef + (fz - S.fzRef) * clamp(dt / LIGHT_REF_TAU, 0, 1), MIN_LOAD * 4) end
      local edge = math.max(LIGHT_FRAC * S.fzRef, MIN_LOAD * 2)
      local light = (broken or S.air) and 0 or clamp((edge - S.fzLp) / (edge - MIN_LOAD), 0, 1)
      -- Unloaded but not (yet) shown off the ground (a bump, or just lifting): the grip and
      -- slide hold what they showed, rather than the bar dropping to nothing for a moment.
      local hold = unloaded and not S.air and not broken
      if math.abs(drive) > 1 then everDriven[i] = true end
      local driven
      if hasGraph then driven = liveDriven[i] or false
      else driven = lay.drivetrain.driven[i] or everDriven[i] or w.isPropulsed == true end

      -- slow-moving load: drive torque as a share of what the tyre can take
      S.fzAvg = S.fzAvg + (math.max(fz, 0) - S.fzAvg) * loadK
      local capacity = MU_NOMINAL * math.max(S.fzAvg, 300) * radius

      -- grip use
      local use = 0
      if not airborne then
        local fx = math.max(math.abs(drive), (speed > STANDSTILL_SPEED) and brake or 0) / radius
        local fy = fz * math.abs(kin.latAccel) / G
        use = math.max(math.sqrt(fx * fx + fy * fy) / (MU_NOMINAL * fz), slip / SLIP_PEAK)
      end
      if not hold then
        S.grip = S.grip + (use - S.grip) * gripK
        if airborne then S.sliding = false
        elseif slip > SLIP_LIMIT then S.sliding = true
        elseif slip < SLIP_LIMIT * SLIP_RELEASE then S.sliding = false end
      end
      local severity = 0
      if S.sliding then
        local ratio = slip / math.max(speed, RATIO_MIN_SPEED)
        if ratio <= SLIP_RATIO_PINK then severity = PINK_SEVERITY * ratio / SLIP_RATIO_PINK
        else
          severity = PINK_SEVERITY + (1 - PINK_SEVERITY) * clamp((ratio - SLIP_RATIO_PINK) / (SLIP_RATIO_FULL - SLIP_RATIO_PINK), 0, 1)
        end
      end
      if not hold then S.severity = S.severity + (severity - S.severity) * gripK end

      -- torque: + drive, - braking (engine braking and regen count as braking)
      local driveFrac, brakeFrac = 0, 0
      if throttle > 0.02 then driveFrac = math.abs(drive) / capacity
      else brakeFrac = math.abs(drive) / capacity end
      local driveline = clamp(driveFrac, 0, 1) - clamp(brakeFrac, 0, 1)   -- tints shafts and axles
      if brakeMax > 0 then brakeFrac = math.max(brakeFrac, brake / brakeMax) end
      local torque = clamp(driveFrac, 0, 1) - clamp(brakeFrac, 0, 1)

      -- steering, against a straight-ahead reference that's kept true whenever you're really
      -- driving straight (an off-centre capture or a knock to the alignment leaves no offset)
      local rawYaw = axleYaw(w, fwd, right)
      if snapNow and not L.centred and not broken then
        L.steerBase, L.centred = rawYaw, true
      elseif centreNow and not broken then
        local d = rawYaw - L.steerBase
        if d > math.pi / 2 then d = d - math.pi elseif d < -math.pi / 2 then d = d + math.pi end
        L.steerBase = L.steerBase + d * centreK
      end
      local steer = rawYaw - L.steerBase
      if steer > math.pi / 2 then steer = steer - math.pi end
      if steer < -math.pi / 2 then steer = steer + math.pi end
      S.steer = steer
      if front and L.y > front.y - 0.3 and not broken then fSum, fN = fSum + steer, fN + 1 end
      if rear and L.y < rear.cut and not broken then rSum, rN = rSum + steer, rN + 1 end

      -- assist acting on this wheel: 1 = ABS, 2 = traction control, 3 = ESC. From BeamNG's own
      -- brake numbers (wheels.lua): desiredMainBrakingTorque is the pedal's share after brake
      -- split and ABS; desiredBrakingTorque is what the wheel is finally asked for, which ESC
      -- and traction control raise above the pedal's and handbrake's.
      local iv = nil
      local usage = w.defaultBrakeInputUsageCoef or 1
      local mainReq = math.abs(w.desiredMainBrakingTorque or 0)
      local parkReq = (w.parkingTorque or 0) * ax.parkIn * usage
      local added = math.abs(w.desiredBrakingTorque or 0) - math.max(mainReq, parkReq)
      local assistBrake = added > math.max(ESC_BRAKE_MARGIN, brakeMax * 0.03)
      if ax.escBraking and assistBrake then iv = 3 end
      if ax.tcBraking and assistBrake then tcBraked[i] = true end
      if not iv and ax.drivingDynamics and (tcBraked[i] or cutWheel[i]) then iv = 2 end
      if not iv and ax.hasABS and ax.brakeOn then
        local bIn = (tonumber(ev[w.brakeElectricsName or "brake"]) or ax.brakeIn) * usage
        local split = w.brakeInputSplit or 1
        local nonABS = brakeMax * (math.min(bIn, split) + math.max(bIn - split, 0) * (w.brakeSplitCoef or 1))
        local reduced = w.desiredMainBrakingTorque ~= nil and nonABS > ESC_BRAKE_MARGIN and mainReq < nonABS * 0.9
        if w.absActive == true or w.absActive == 1 or reduced then iv = 1; ax.absOn = true end
      end

      o.d  = driven and 1 or 0                         -- connected to a power source
      o.s  = round(steer, 4)                           -- steering angle, rad, + = left
      o.g  = round(S.grip, 3)                          -- grip used, 1 = 100 %
      o.e  = S.sliding and 1 or 0                      -- sliding
      o.ex = S.sliding and round(S.severity, 3) or 0   -- how far past the limit, 0..1
      o.t  = round(torque, 3)                          -- -1 full brake .. +1 full drive
      o.dr = round(driveline, 3)                       -- driveline only: + drive, - engine braking / regen
      o.b  = broken and 1 or 0
      o.a  = (S.air and not broken) and 1 or nil      -- off the ground
      o.lf = (light > 0.02) and round(light, 2) or nil -- nearly off the ground, 0..1
      o.fl = (not broken and (w.isTireDeflated or w.isPunctured)) and 1 or nil   -- flat or punctured
      o.sl = round(slip, 2)                            -- contact-patch slip, m/s
      o.iv = iv
    end
  end
  est.frontSteer = fN > 0 and fSum / fN or nil
  est.rearSteer = rN > 0 and rSum / rN or 0
  est.rearSteerN = rN
end

-- The steering scale (see TUNE.STEER_EXPAND), the same as the app's.
local function asinhNorm(x, k) return math.log(k * x + math.sqrt(k * k * x * x + 1)) / math.log(k + math.sqrt(k * k + 1)) end
local function steerK(ref)
  local k0, target, kMax = TUNE.STEER_EXPAND, TUNE.STEER_TARGET, TUNE.STEER_K_MAX
  if not (target > 0) or not ref or not (ref > 0) or ref >= 1 then return k0 end
  if k0 > 0 and asinhNorm(ref, k0) >= target then return k0 end
  if asinhNorm(ref, kMax) <= target then return kMax end
  local lo, hi = math.log(math.max(k0, 1)), math.log(kMax)
  for _ = 1, 30 do   -- asinhNorm grows with k: bisect on log k
    local mid = (lo + hi) / 2
    if asinhNorm(ref, math.exp(mid)) < target then lo = mid else hi = mid end
  end
  return math.exp((lo + hi) / 2)
end
local function toScale(x, k)   -- steering-input units -> share of the quarter turn as drawn
  local a = math.abs(x)
  if not (k > 0) or a >= 1 then return x end
  return (x < 0 and -1 or 1) * asinhNorm(a, k)
end
local function fromScale(u, k)
  local a = math.abs(u)
  if not (k > 0) or a >= 1 then return u end
  local e = math.exp(a * math.log(k + math.sqrt(k * k + 1)))
  return (u < 0 and -1 or 1) * (e - 1 / e) / 2 / k
end

-- the marker's smoothing (see TUNE.MARK_MIN_CUTOFF), on where it's drawn, in degrees of rim.
-- grip: 1 while the rear grips, easing to 0 as it slides. In a slide the marker comes from the
-- hubs' measurement, already smoothed and moving a long way, so the smoothing fades out with
-- it and a slide is shown as quickly as ever.
local function markerFilter(dt, tv, steerIn, k, grip)
  local x, s = toScale(tv, k) * 90, toScale(steerIn, k) * 90
  if not mark.init then
    mark.y, mark.d, mark.df, mark.ds, mark.s, mark.init = x, 0, 0, 0, s, true
    return tv
  end
  local rate = (x - mark.y) / dt
  mark.d = mark.d + (rate - mark.d) * lpAlpha(TUNE.MARK_D_CUTOFF, dt)
  mark.df = mark.df + (rate - mark.df) * lpAlpha(TUNE.MARK_D_FAST_CUTOFF, dt)
  mark.ds = mark.ds + ((s - mark.s) / dt - mark.ds) * lpAlpha(TUNE.MARK_STEER_CUTOFF, dt)
  mark.s = s
  local fast = math.max(0, math.abs(mark.df) - TUNE.MARK_FAST_FROM)
  local cutoff = TUNE.MARK_MIN_CUTOFF + TUNE.MARK_BETA * math.abs(mark.d) + TUNE.MARK_BETA2 * fast * fast
    + TUNE.MARK_STEER_GAIN * math.abs(mark.ds)
  mark.y = mark.y + (x - mark.y) * lpAlpha(cutoff, dt)
  if grip < 1 then mark.y = x + (mark.y - x) * grip end
  return fromScale(mark.y / 90, k)
end

-- How much the car is actually turning, as a steering angle, on the steering arc's scale, and
-- the understeer / oversteer balance.
-- ===== Grip model (see TUNE.GRIP_RATIO_PEAK) =================================
-- A running straight-line fit of an axle's force against its slip, F = C (slip - offset), with
-- an exponential forgetting: the slope is the stiffness; the offset soaks up any small constant
-- error in the measured slip (the straight-ahead calibration, the hubs), which would otherwise
-- matter most for stiff tyres that corner on a fraction of a degree.
local function fitNew(c0, weight, ref)   -- a prior: two points at +-ref on the line through 0 with slope c0
  local w = weight
  return { n = 2 * w, sa = 0, sf = 0, saa = 2 * w * ref * ref, saf = 2 * w * c0 * ref * ref }
end
local function fitAdd(f, a, F, w, decay)
  f.n, f.sa, f.sf = f.n * decay + w, f.sa * decay + w * a, f.sf * decay + w * F
  f.saa, f.saf = f.saa * decay + w * a * a, f.saf * decay + w * a * F
end
local function fitSolve(f)   -- slope, offset (slip at zero force), spread of the slip seen
  local va = f.n * f.saa - f.sa * f.sa
  if va <= 1e-14 or f.n <= 0 then return nil end
  local c = (f.n * f.saf - f.sa * f.sf) / va
  if c <= 0 then return nil end
  return c, (f.sa - f.sf / c) / f.n, math.sqrt(math.max(0, va) / (f.n * f.n))
end
local function beamngStiffness()
  if not (controller and controller.getAllControllers) then return nil end
  local okA, all = pcall(controller.getAllControllers)
  if not okA or type(all) ~= "table" then return nil end
  for _, c in pairs(all) do
    if type(c) == "table" then
      local vs = type(c.vehicleData) == "table" and c.vehicleData.vehicleStats
      if type(vs) == "table" and (tonumber(vs.skewStiffnessFront) or 0) > 1000 and (tonumber(vs.skewStiffnessRear) or 0) > 1000 then
        return vs.skewStiffnessFront, vs.skewStiffnessRear, "drivingDynamics"
      end
      if type(c.getCurrentConfigData) == "function" then
        local okC, cfg = pcall(c.getCurrentConfigData)
        if okC and type(cfg) == "table" and (tonumber(cfg.skewStiffnessFront) or 0) > 1000 and (tonumber(cfg.skewStiffnessRear) or 0) > 1000 then
          return cfg.skewStiffnessFront, cfg.skewStiffnessRear, "esc"
        end
      end
    end
  end
  return nil
end
-- Once per layout: mass, where the centre of gravity sits between the axles, the stiffness.
local function gripSetup()
  for k in pairs(gm) do gm[k] = nil end
  gm.lv = tx.lv
  local front, rear = lay.front, lay.rear
  if not (front and rear and lay.mass and lay.mass > 50) then return end
  local L = front.y - rear.y
  if L < 0.5 then return end
  local cgy = lay.cgy or (front.y + rear.y) / 2
  local a = clamp(front.y - cgy, 0.15 * L, 0.85 * L)   -- centre of gravity to the front axle
  local b = L - a
  gm.m, gm.a, gm.b, gm.L, gm.Iz = lay.mass, a, b, L, lay.mass * a * b   -- yaw inertia: the usual m a b
  local cf, cr, src = beamngStiffness()
  local ref = 0.004  -- the prior: points at 0.004 rad of slip, about what gentle cornering gives
  if cf then
    gm.src, gm.ready = src, true
    gm.fitF, gm.fitR = fitNew(cf, TUNE.CAL_PRIOR_BNG, ref), fitNew(cr, TUNE.CAL_PRIOR_BNG, ref)
  else   -- a road tyre's usual stiffness (about 17 x its load per rad), held only lightly
    gm.src, gm.ready = "learnt", false
    local fz, rz = gm.m * G * b / L, gm.m * G * a / L
    gm.fitF, gm.fitR = fitNew(17 * fz, 0.1, ref), fitNew(17 * rz, 0.1, ref)
  end
  gm.bngF, gm.bngR = cf, cr
  gm.calT, gm.ay, gm.rdot, gm.prevYaw = 0, 0, 0, nil
  gm.nF, gm.dF, gm.nR, gm.dR, gm.pF, gm.pR, gm.linF, gm.linR, gm.offF, gm.offR = 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
end
-- Each frame: the axles' sideways forces and slip (in the direction the car is turning) and
-- from them each axle's proximity to its limit, learning the stiffness when conditions allow.
local function gripStep(dt, slipF, slipR, turn, rearSliding, steady, steerF, steerR)
  if gm.lv ~= tx.lv then gripSetup() end
  if not gm.m then return end
  -- Each axle's direction of travel is measured across the last TRAVEL_WINDOW, so it belongs to
  -- half that long ago; compare it with where the wheels pointed then, not now, or turning the
  -- steering shows up as slip (which matters at low speed, where the real slip is tiny).
  local h = gm.hist or {}
  gm.hist = h
  h[#h + 1] = { t = clock, f = steerF or 0, r = steerR or 0 }
  while #h > 2 and h[2].t <= clock - TRAVEL_WINDOW do table.remove(h, 1) end
  local tLag = clock - TRAVEL_WINDOW / 2
  local lagF, lagR = steerF or 0, steerR or 0
  for i = #h, 2, -1 do
    local a, b = h[i - 1], h[i]
    if a.t <= tLag then
      local u = (b.t > a.t) and clamp((tLag - a.t) / (b.t - a.t), 0, 1) or 1
      lagF, lagR = a.f + (b.f - a.f) * u, a.r + (b.r - a.r) * u
      break
    end
  end
  slipF = slipF - ((steerF or 0) - lagF)
  slipR = slipR - ((steerR or 0) - lagR)
  -- in the body's frame (+ = to the left), so left and right turns and straight running all
  -- feed one fit
  local ay = -(kin.aLatRaw or kin.latAccel)             -- m/s^2, + = to the left
  local yaw = kin.yawFast or kin.yawRate                -- the quick yaw rate: its change leads the force
  local rd = gm.prevYaw and (yaw - gm.prevYaw) / dt or 0
  gm.prevYaw = yaw
  -- the acceleration comes from a short fit over the last moment, so it lags a little: the slip
  -- and the change of rotation are smoothed to lag just as much, so force and slip line up
  local k = lpAlpha(TUNE.GRIP_HZ, dt)
  local ks, kr = lpAlpha(TUNE.GRIP_SLIP_HZ, dt), lpAlpha(TUNE.GRIP_RD_HZ, dt)
  gm.ay = gm.ay + (ay - gm.ay) * k
  gm.rdot = gm.rdot + (rd - gm.rdot) * kr
  -- the axle forces a rigid car needs for this sideways acceleration and change of rotation
  local Ff = (gm.m * gm.ay * gm.b + gm.Iz * gm.rdot) / gm.L
  local Fr = (gm.m * gm.ay * gm.a - gm.Iz * gm.rdot) / gm.L
  gm.nF, gm.dF = Ff, gm.dF + (slipF - gm.dF) * ks
  gm.nR, gm.dR = Fr, gm.dR + (slipR - gm.dR) * ks
  -- learn while driving gently and steadily (straight running counts: it pins the offset)
  if steady and not rearSliding and (kin.speed or 0) > 8 and math.abs(gm.ay) < TUNE.CAL_AY_HI
     and math.abs(gm.rdot) < 0.3 and math.abs(gm.dF) < TUNE.CAL_SLIP_HI and math.abs(gm.dR) < TUNE.CAL_SLIP_HI then
    local decay = math.exp(-dt / TUNE.CAL_TAU)
    fitAdd(gm.fitF, gm.dF, gm.nF, dt, decay)
    fitAdd(gm.fitR, gm.dR, gm.nR, dt, decay)
    if math.abs(gm.ay) > TUNE.CAL_AY_LO then gm.calT = gm.calT + dt end
  end
  local cf, of, sprF = fitSolve(gm.fitF)
  local cr, orr, sprR = fitSolve(gm.fitR)
  if cf then gm.cf, gm.offF = cf, of end
  if cr then gm.cr, gm.offR = cr, orr end
  -- a learnt value is trusted once there's been enough cornering, over a spread of slip
  if not gm.ready and gm.calT >= TUNE.CAL_READY and (sprF or 0) > TUNE.CAL_SPREAD and (sprR or 0) > TUNE.CAL_SPREAD * 0.5 then gm.ready = true end
  -- proximity to the limit, in the direction the car is turning, with the slip offset taken out
  local function proximity(n, d, c)
    n, d = n * turn, d * turn
    if not c or c <= 0 or d < TUNE.GRIP_MIN_SLIP then return 0 end
    local ratio = clamp(n / (c * d), -1, 1.5)
    return clamp((1 - ratio) / (1 - TUNE.GRIP_RATIO_PEAK), 0, 2)
  end
  -- at walking pace the slip is too small to judge against the measurement's resolution
  local slowFade = clamp(((kin.speed or 0) - TUNE.GRIP_MIN_SPEED) / 3, 0, 1)
  gm.pF = proximity(gm.nF, gm.dF - (gm.offF or 0), gm.cf) * slowFade
  gm.pR = proximity(gm.nR, gm.dR - (gm.offR or 0), gm.cr) * slowFade
  -- the slip (in the turn's direction) each axle would need for its force if its tyres were linear
  gm.linF = gm.cf and gm.nF / gm.cf * turn + (gm.offF or 0) * turn or 0
  gm.linR = gm.cr and gm.nR / gm.cr * turn + (gm.offR or 0) * turn or 0
end

-- The balance as a state, for the marker and the numbers mode: 0 neutral, 1 front near its
-- limit, 2 understeer, 3 rear near its limit, 4 both at their limit, 5 oversteer (a controlled
-- drift is oversteer with inp.dc). The warnings for the rear and for both come from the grip
-- model, so only once the tyres' stiffness is known; before that the states follow the balance.
local function balanceStateOf(prev, bal, measured, rearSliding)
  if not measured then return 0 end
  if bal >= (prev == 5 and 0.12 or 0.15) then return 5 end
  if rearSliding then return 0 end   -- a slide that isn't oversteer (yet): no warnings, they'd mean nothing
  if not gm.ready then
    if bal <= -(prev == 2 and TUNE.US_WARN_SHARE - 0.05 or TUNE.US_WARN_SHARE) then return 2 end
    if bal <= ((prev == 1 or prev == 2) and -0.02 or -0.04) then return 1 end
    return 0
  end
  if math.abs(kin.yawRate) < TUNE.US_MIN_YAW * 0.5 then return 0 end
  local lead = gm.pF - gm.pR
  if bal <= -(prev == 2 and TUNE.US_WARN_SHARE - 0.05 or TUNE.US_WARN_SHARE) then return 2 end
  local wasF, wasR = prev == 1 or prev == 2 or prev == 4, prev == 3 or prev == 4 or prev == 5
  local nearF = gm.pF >= (wasF and TUNE.NEAR_OFF or TUNE.NEAR_ON)
  local nearR = gm.pR >= (wasR and TUNE.NEAR_OFF or TUNE.NEAR_ON)
  if nearF and nearR then
    if lead > TUNE.LEAD then return 1 elseif lead < -TUNE.LEAD then return 3 end
    return 4
  end
  if nearF then return 1 end
  if nearR then return 3 end
  return 0
end

local function updateTravel(dt, fwd, right, ev)
  local inputs = out.inp
  local steerIn = clamp(-(ev.steering_input or 0), -1, 1)
  -- full-lock road-wheel angle, learned from how far the front wheels turn
  if est.frontSteer and math.abs(steerIn) > 0.15 then
    local front = math.abs(est.frontSteer)
    if front > 0.02 then est.lock = est.lock + (clamp(front / math.abs(steerIn), 0.15, 1.4) - est.lock) * clamp(3 * dt, 0, 1) end
  end

  -- Balance: each axle's slip angle is where its wheels point minus where it's going (folded
  -- to +-90 deg: a tyre rolling backwards in a spin is rolling, not sliding). The direction
  -- comes from the yaw rate, which keeps its sign through drifts and spins.
  local function slipAngle(steerAvg, travel)
    local d = steerAvg - travel
    return math.atan2(math.sin(d), math.abs(math.cos(d)))
  end
  local front, rear = lay.front, lay.rear
  local target = 0
  est.slipF, est.slipR = nil, nil
  if front and rear and est.frontSteer then
    local slipR = slipAngle(est.rearSteer, kin.rearTravel)
    local slipF = slipAngle(est.frontSteer, kin.travel)
    est.slipF, est.slipR = slipF, slipR
    local turn = kin.yawRate >= 0 and 1 or -1
    local diff = (slipR - slipF) * turn                    -- + = rear slipping more
    -- how far the rear is sliding (a slide or spin is oversteer, whatever the front does)
    local rs = smoothstep((math.abs(kin.rearTravel) - TUNE.REAR_GRIP_SLIP) / (TUNE.REAR_SLIDE_SLIP - TUNE.REAR_GRIP_SLIP))
    est.rs = rs
    local steady = not (ax.absOn or ax.tcsOn or ax.escOn or ax.anyCut or ax.powerCut) and math.abs(kin.gy) < 0.2
    gripStep(dt, slipF, slipR, turn, rs > 0.02, steady, est.frontSteer, est.rearSteer)
    local yawOver = clamp(math.abs(kin.yawRate) / TUNE.BAL_MIN_YAW, 0, 1)
    local yawUnder = clamp(math.abs(kin.yawRate) / TUNE.US_MIN_YAW, 0, 1)
    if gm.ready then
      -- With the tyres' stiffness known (see the grip model): oversteer is the rear slipping more
      -- than the front beyond what linear tyres would need for the forces (the car's own,
      -- designed balance taken out, as BeamNG's stability control does with its expected yaw
      -- rate), with the rear near or past its limit; understeer is the front past its peak, and
      -- nearer its limit than the rear.
      local diffEx = diff + gm.linF - gm.linR
      local rearGate = math.max(clamp((math.abs(slipR) - TUNE.BAL_SLIP_START) / (TUNE.BAL_SLIP_FULL - TUNE.BAL_SLIP_START), 0, 1),
                                clamp((gm.pR - 0.8) / 0.4, 0, 1))
      local over = smoothstep((diffEx - TUNE.BAL_DEADBAND) / (TUNE.BAL_FULL - TUNE.BAL_DEADBAND)) * rearGate * yawOver
      if over > 0 then target = over
      else
        local lead = clamp((gm.pF - gm.pR - 0.05) / 0.2, 0, 1)
        local near = smoothstep((gm.pF - 0.45) / (0.75 - 0.45))
        local past = smoothstep((gm.pF - 0.85) / (1.15 - 0.85))
        target = -(TUNE.US_WARN_SHARE * near + (1 - TUNE.US_WARN_SHARE) * past) * lead * yawUnder * (1 - rs)
      end
    elseif diff >= 0 then
      local mag = smoothstep((diff - TUNE.BAL_DEADBAND) / (TUNE.BAL_FULL - TUNE.BAL_DEADBAND))
      mag = mag * clamp((math.abs(slipR) - TUNE.BAL_SLIP_START) / (TUNE.BAL_SLIP_FULL - TUNE.BAL_SLIP_START), 0, 1)
      target = mag * yawOver
    else
      local frontWork = clamp((slipF * turn - TUNE.US_SLIP_START) / (TUNE.US_SLIP_FULL - TUNE.US_SLIP_START), 0, 1)
      local frontLead = clamp((-diff - TUNE.US_LEAD_START) / (TUNE.US_LEAD_FULL - TUNE.US_LEAD_START), 0, 1)
      local pastPeak = clamp((slipF * turn - TUNE.US_PAST_START) / (TUNE.US_PAST_FULL - TUNE.US_PAST_START), 0, 1)
        * clamp((-diff - TUNE.US_PAST_LEAD) / (TUNE.US_PAST_LEAD_FULL - TUNE.US_PAST_LEAD), 0, 1)
      local severity = TUNE.US_WARN_SHARE * frontWork * frontLead + (1 - TUNE.US_WARN_SHARE) * pastPeak
      target = -severity * yawUnder * (1 - rs)
    end
  end
  est.balance = est.balance + (target - est.balance) * clamp(TRAVEL_SMOOTH_HZ * dt, 0, 1)
  -- a warning (an axle near its limit) shows once it has held a moment, so a quick transient at
  -- turn-in doesn't flash one; understeer and oversteer show at once
  local cand = balanceStateOf(est.state, est.balance, front and rear and est.frontSteer, est.rs and est.rs > 0.05)
  local warn = cand == 1 or cand == 3 or cand == 4
  if cand ~= est.cand then est.cand, est.candT = cand, 0 else est.candT = (est.candT or 0) + dt end
  if not warn or est.state == 2 or est.state == 5 or est.candT >= TUNE.WARN_HOLD or (est.state ~= 0 and (cand == 1 or cand == 3 or cand == 4)) then est.state = cand end

  -- how controlled a slide is (see TUNE.DRIFT_STEER_OK): 1 = a controlled drift
  local control = 0
  if est.slipF and rear then
    local slide = wrapAngle(est.rearSteer - kin.rearTravel)   -- the rear's true sliding angle
    local rate = est.prevSlide and wrapAngle(slide - est.prevSlide) / dt or 0
    est.prevSlide = slide
    est.slideRate = est.slideRate + (rate - est.slideRate) * lpAlpha(TUNE.DRIFT_RATE_HZ, dt)
    local growing = math.max(0, est.slideRate * (slide >= 0 and 1 or -1))   -- shrinking (recovering) is fine
    local steerOk = 1 - smoothstep((math.abs(est.slipF) - TUNE.DRIFT_STEER_OK) / (TUNE.DRIFT_STEER_OFF - TUNE.DRIFT_STEER_OK))
    local holding = 1 - smoothstep((growing - TUNE.DRIFT_GROW_OK) / (TUNE.DRIFT_GROW_OFF - TUNE.DRIFT_GROW_OK))
    control = (math.abs(slide) > TUNE.DRIFT_MAX_ANGLE) and 0 or steerOk * holding
  else
    est.prevSlide = nil
  end
  est.drift = est.drift + (control - est.drift) * clamp(TRAVEL_SMOOTH_HZ * dt, 0, 1)

  -- Shown whenever the car is moving, including sliding backwards in a spin, but not when
  -- reversing on purpose (reverse gear and rolling backwards).
  local vel = kin.vel
  local vFwd = vel:dot(fwd)
  local speed2d = math.sqrt(vFwd ^ 2 + vel:dot(right) ^ 2)
  local reversing = (ev.gearIndex or 0) < 0 and vFwd < 0
  inputs.tv, inputs.sr, inputs.k, inputs.ta, inputs.bal, inputs.dc, inputs.bs = nil, nil, nil, nil, nil, nil, nil
  est.shown = nil
  if speed2d > TRAVEL_FADE_LO and front and not reversing then
    -- The front axle's direction against the rear axle's path while the rear grips (plus any
    -- rear steer), easing over to the front's direction against the body as the rear slides
    -- (the countersteer target). From the rear's true sliding angle, not folded: an axle
    -- sliding backwards in a spin is fully sliding.
    local w = 1
    if rear then
      local slide = math.abs(wrapAngle(est.rearSteer - kin.rearTravel))
      w = 1 - smoothstep((slide - TUNE.REAR_GRIP_SLIP) / (TUNE.REAR_SLIDE_SLIP - TUNE.REAR_GRIP_SLIP))
    end
    local kinHub = rear and (kin.travel - kin.rearTravel) or kin.travel
    local kinTurn = kinHub
    if rear and vFwd > 3 then
      -- rigid car: front minus rear direction = atan(wheelbase x yaw rate / forward speed)
      -- (calibrated against the hubs with the smoothed yaw rate, whose delay matches theirs;
      -- shown from the unsmoothed one, for the least delay)
      local wb = front.y - rear.y
      local kinYaw = math.atan2(wb * kin.yawRate, vFwd)
      if w > 0.99 and math.abs(kinYaw) > 0.003 then   -- calibrate against the hubs while gripping
        local f = 1 - dt / TUNE.TURN_CAL_TAU
        est.kn = est.kn * f + kinHub * kinYaw
        est.kd = est.kd * f + kinYaw * kinYaw
      end
      est.cal = clamp((est.kn + 0.002) / (est.kd + 0.002), 0.6, 1.4)
      kinTurn = est.cal * math.atan2(wb * kin.yawFast, vFwd)
    end
    local rs = est.rearSteer
    if math.abs(rs) < 0.01 then rs = 0 end   -- unsteered rear axle: ignore the nodes' noise
    local shown = (1 - w) * kin.travel + w * (kinTurn + rs)
    est.shown = shown
    diag.shown, diag.kinHub, diag.kin = shown, kinHub, kinTurn

    -- In steering-input units, with the ratio the wheels show right now (TUNE.RATIO_TAU), so
    -- the marker meets the arc whenever front and rear tyres slip equally.
    if est.frontSteer then
      local f = 1 - dt / TUNE.RATIO_TAU
      est.rn = est.rn * f + est.frontSteer * steerIn
      est.rd = est.rd * f + steerIn * steerIn
    end
    local eps = 2e-4   -- a little of the full-lock ratio, for when there's been no steering
    est.ratio = clamp((est.rn + est.lock * eps) / (est.rd + eps), est.lock * 0.3, est.lock * 1.5)
    -- the steering a 1 g corner needs at this speed sets the scale's stretch (TUNE.STEER_TARGET)
    local sr = (rear and vFwd > 3) and ((front.y - rear.y) * G / (vFwd * vFwd) + 0.03) / est.lock or nil
    local k = steerK(sr)
    inputs.sr = sr and round(sr, 4) or nil
    inputs.k = round(k, 3)                           -- the scale's stretch, for the app
    local tvRaw = clamp(shown / est.ratio, -TRAVEL_MAX, TRAVEL_MAX)
    diag.tvRaw = tvRaw
    inputs.tv = round(clamp(markerFilter(dt, tvRaw, steerIn, k, w), -TRAVEL_MAX, TRAVEL_MAX), 6)   -- + = left of the nose
    inputs.ta = round(clamp((speed2d - TRAVEL_FADE_LO) / (TRAVEL_FADE_HI - TRAVEL_FADE_LO), 0, 1), 2)
    inputs.bal = round(est.balance, 3)   -- -1 understeer .. 0 neutral .. +1 oversteer
    inputs.bs = est.state                -- the state (see balanceStateOf)
    inputs.dc = (est.balance > 0.01) and round(est.drift, 2) or nil   -- oversteer: 1 = a controlled drift
  else
    mark.init = false   -- hidden: start afresh when it shows again
  end

  -- Inputs for the rim arcs. Steering like BeamNG's Steering app (steering_input, negative to
  -- the left; we send + = left); pedals like its Simple Pedals app (applied throttle, brake,
  -- clutch, parkingbrake in whole percent: anything not exactly 0 shows at least 1 %, only
  -- exactly full shows 100 %).
  inputs.s = round(steerIn, 5)   -- fine enough that the stretched centre of the scale moves smoothly
  inputs.t = pedalLevel(ev.throttle)
  inputs.b = pedalLevel(ev.brake)
  inputs.c = pedalLevel(ev.clutch)
  inputs.p = pedalLevel(ev.parkingbrake)
end

-- Extra values for the app's numbers mode (only while it's on, and only when sending): the load
-- on every wheel, and the front and rear axle slip angles behind the balance readout.
local function fillDetail()
  for _, o in ipairs(out.w) do
    local w = wheels.wheels[o.i]
    o.fz = w and math.floor((w.downForce or w.downForceRaw or 0) + 0.5) or nil   -- load, N
  end
  local vd = vdOut
  local turnSign = kin.yawRate >= 0 and 1 or -1
  vd.af = est.slipF and round(est.slipF * turnSign, 4) or nil   -- front / rear axle slip angle, in the turn's direction
  vd.ar = est.slipR and round(est.slipR * turnSign, 4) or nil
end

-- ===== Sending =============================================================

local function transmit(payload)
  if guihooks and guihooks.trigger then
    guihooks.trigger('VGSData', payload)          -- straight to the UI, no game-engine hop
  else                                            -- older game versions: through the hub
    obj:queueGameEngineLua(string.format("if extensions.vgsHub then extensions.vgsHub.onVehicleJson(%q) end", jsonEncode(payload)))
  end
end

-- What this vehicle is coupled to right now: BeamNG's own record of its attached couplers
-- (so a trailer hitched before the app opened counts too), plus the coupler events seen since.
local function couplings()
  local set, me = {}, obj:getId()
  for id in pairs(coupled) do set[id] = true end
  local att = beamstate and beamstate.attachedCouplers
  if type(att) == "table" then
    for _, c in pairs(att) do
      local other = type(c) == "table" and tonumber(c.obj2id) or nil
      if other and other ~= me and other >= 0 then set[other] = true end
    end
  end
  return set
end

local function pingHub()
  local list = {}
  for id in pairs(couplings()) do list[#list + 1] = id end
  table.sort(list)
  obj:queueGameEngineLua(string.format("if extensions.vgsHub then extensions.vgsHub.onVehiclePing(%d, {%s}) end",
    obj:getId(), table.concat(list, ",")))
end

-- Does the UI want a new frame? BeamNG's UI acknowledges each frame it has drawn; sending only
-- then means every update is drawn at once, with no backlog building up when the game runs
-- faster than the UI.
local function uiWantsFrame()
  if tx.uiFlag == nil then
    tx.uiFlag = false
    if obj.getUpdateUIflag then tx.uiFlag = pcall(obj.getUpdateUIflag, obj) end
  end
  if not tx.uiFlag then return tx.since >= 0.95 / FALLBACK_HZ end
  local ok, want = pcall(obj.getUpdateUIflag, obj)
  if not ok then return tx.since >= 0.95 / FALLBACK_HZ end
  if want then return MAX_SEND_HZ <= 0 or tx.since >= 0.95 / MAX_SEND_HZ end
  return tx.since >= KEEPALIVE
end

local function send(fwd, right, ev)
  local pos = obj:getPosition()
  local p = out
  p.v, p.id, p.lv = PROTOCOL, obj:getId(), tx.lv
  -- when this frame happened, in real milliseconds, so the app can space the updates exactly
  -- as the game produced them and draw smooth motion between them at the screen's own rate
  p.ts = round(realMs(), 2)
  p.pl = (playerInfo and playerInfo.firstPlayerSeated) and 1 or nil
  p.px, p.py = round(pos.x, 2), round(pos.y, 2)
  p.hx, p.hy = round(fwd.x, 4), round(fwd.y, 4)
  for k = #couplerList, 1, -1 do couplerList[k] = nil end
  if tx.sincePing == 0 or not tx.couplings then tx.couplings = couplings() end
  for id in pairs(tx.couplings) do couplerList[#couplerList + 1] = id end
  p.c = (#couplerList > 0) and couplerList or nil
  -- G-force as felt by the driver (opposite to the acceleration), in g:
  -- x + = pushed right (turning left), y + = pushed forward (braking)
  p.gf.x, p.gf.y = round(-kin.gx, 3), round(-kin.gy, 3)
  p.inp.abs = ax.absOn and 1 or nil                          -- ABS working: the brake arc pulses
  for si, s in ipairs(lay.drivetrain.sources) do
    local sc, cut = p.src[si], srcCut[si] or { factor = 1, cut = false }
    local braking = false
    for _, wi in ipairs(s.wheels or {}) do if tcBraked[wi] then braking = true end end
    if braking then ax.anyCut = true end
    -- classic traction control: a green dot on the engine while cutting its power or braking a
    -- wheel it drives (the driving-dynamics kind shows by the wheels)
    sc.tc = (not ax.drivingDynamics and (cut.cut or braking)) and 1 or nil
    sc.tf = (cut.factor < 0.999) and round(cut.factor, 2) or nil
  end
  p.inp.tcs = (ax.powerCut or ax.anyCut) and 1 or nil        -- an assist cutting power: the throttle arc pulses
  if detail then
    fillDetail(); p.vd = vdOut; tx.detailSent = true
  else
    p.vd = nil
    if tx.detailSent then   -- numbers mode just switched off: drop the extra values
      for _, o in ipairs(out.w) do for _, key in ipairs(DETAIL_KEYS) do o[key] = nil end end
      tx.detailSent = false
    end
  end
  -- the layout: when it changes, on request, and every STATIC_EVERY seconds
  local withStatic = tx.staticDue or tx.keyFrames > 0 or tx.sinceStatic >= STATIC_EVERY
  p.st = withStatic and lay.static or nil
  if withStatic then
    tx.sinceStatic, tx.staticDue = 0, false
    if tx.keyFrames > 0 then tx.keyFrames = tx.keyFrames - 1 end
  end
  local okT, err = pcall(transmit, p)
  if not okT then log('W', 'vgsTelemetry', 'send failed: ' .. tostring(err)) end
  p.st = nil
  tx.since = 0
end

-- ===== Diagnostics =========================================================
-- Run from the game-engine Lua console through vgsHub (see vgsHub.lua), or in this vehicle's
-- console as extensions.vgsTelemetry.<name>().
local ASSIST_KEY = { "abs", "tcs", "esc", "traction", "yaw", "stabil", "throttlefactor", "intervention" }
local function say(line) log('I', 'vgsTelemetry', line); print(line) end
local function assistElectrics()
  local res = {}
  for k, val in pairs(electrics.values or {}) do
    local lk = type(k) == "string" and k:lower() or ""
    for _, pat in ipairs(ASSIST_KEY) do
      if lk:find(pat, 1, true) and type(val) ~= "table" then res[k] = val; break end
    end
  end
  return res
end

local function dumpAssists()
  local vals, keys = assistElectrics(), {}
  for k in pairs(vals) do keys[#keys + 1] = k end
  table.sort(keys)
  say("electrics: " .. (#keys == 0 and "(no assist-related values)" or ""))
  for _, k in ipairs(keys) do say(string.format("  %-24s %s", k, tostring(vals[k]))) end
  forEachWheel(function(i, w)
    local parts = {}
    pcall(function()
      for k, val in pairs(w) do
        local lk = type(k) == "string" and k:lower() or ""
        if (lk:find("abs", 1, true) or lk:find("brake", 1, true) or lk:find("slip", 1, true)) and type(val) ~= "table" and type(val) ~= "function" then
          parts[#parts + 1] = k .. "=" .. tostring(val)
        end
      end
    end)
    table.sort(parts)
    say(string.format("  wheel %s: %s", tostring(w.name), table.concat(parts, "  ")))
  end)
  if controller and controller.getController then
    for _, name in ipairs({ "tractionControl", "yawControl", "absControl", "esc", "brakeControl", "motorTorqueControl", "CMU" }) do
      local ok, c = pcall(controller.getController, name)
      if ok and type(c) == "table" then
        local fns, vals2 = {}, {}
        for k, val in pairs(c) do
          if type(val) == "function" then fns[#fns + 1] = tostring(k)
          elseif type(val) ~= "table" then vals2[#vals2 + 1] = tostring(k) .. "=" .. tostring(val) end
        end
        table.sort(fns); table.sort(vals2)
        say(string.format("  controller %s: functions %s", name, table.concat(fns, ", ")))
        if #vals2 > 0 then say(string.format("  controller %s: values %s", name, table.concat(vals2, ", "))) end
      else
        say(string.format("  controller %-18s -", name))
      end
    end
  end
end

local function watchAssistsStep()
  local function changed(key, val)
    if watch.assistValues[key] ~= val then
      say(string.format("[vgs assists] %s = %s", key, tostring(val)))
      watch.assistValues[key] = val
    end
  end
  for k, val in pairs(assistElectrics()) do changed(k, val) end
  for key, c in pairs(lay.assists or {}) do
    for _, f in ipairs({ "isActing", "isActingAsTC", "isActingAsYC", "isActingAsABS" }) do
      if c[f] ~= nil then changed("controller " .. key .. " " .. f, c[f]) end
    end
  end
  forEachWheel(function(i, w)
    pcall(function()
      for k, val in pairs(w) do
        if type(k) == "string" and k:lower():find("abs", 1, true) and type(val) ~= "table" and type(val) ~= "function" then
          changed("wheel " .. tostring(w.name) .. " " .. k, val)
        end
      end
    end)
  end)
end

local function travelDumpStep(dt)
  watch.travel = watch.travel - dt
  watch.travelNext = watch.travelNext - dt
  if watch.travelNext > 0 then return end
  watch.travelNext = 0.25
  local function deg(a) return a and string.format("%+6.1f", math.deg(a)) or "   n/a" end
  local function num(a) return a and string.format("%+5.2f", a) or "  n/a" end
  say(string.format(
    "[vgs travel] %4.1f m/s  steer in %+.2f  front wheels %s deg  lock %4.1f deg (input-to-wheel ratio now %4.1f deg, turn cal x%.2f) | shown %s deg | front going %s deg (hubs %s, yaw %s)  rear %s deg | yaw rate: physics %s (sign %+d), heading %s, used %s rad/s | balance %+.2f",
    kin.speed, clamp(-(electrics.values.steering_input or 0), -1, 1), deg(est.frontSteer), math.deg(est.lock),
    math.deg(est.ratio or est.lock), est.cal, deg(diag.shown),
    deg(kin.travel), deg(diag.frontHub), deg(diag.frontYaw), deg(kin.rearTravel),
    num(kin.physYaw), kin.yawSign, num(kin.headYaw), num(kin.yawRate), est.balance))
  local names = { [0] = "neutral", "front near limit", "understeer", "rear near limit", "at the limit", "oversteer" }
  if gm.m then
    say(string.format(
      "[vgs grip]   tyre stiffness front %s rear %s N/rad (%s%s) | how near the limit (1 = at it): front %.2f rear %.2f | state: %s",
      gm.cf and string.format("%.0f", gm.cf) or "n/a", gm.cr and string.format("%.0f", gm.cr) or "n/a",
      gm.src == "learnt" and "learnt while driving" or ("BeamNG's " .. tostring(gm.src) .. " calibration"),
      gm.ready and "" or ", still learning: using slip angles meanwhile", gm.pF or 0, gm.pR or 0, names[est.state or 0] or "?"))
  else
    say("[vgs grip]   no grip model for this vehicle (no mass or axles found): using slip angles | state: " .. (names[est.state or 0] or "?"))
  end
end

-- ===== Main loop ===========================================================

local function step(dt)
  if watch.assists then watchAssistsStep() end
  if not active or not dt or dt <= 0 then return end
  clock = clock + dt
  tx.since, tx.sinceStatic, tx.sincePing = tx.since + dt, tx.sinceStatic + dt, tx.sincePing + dt
  if tx.sincePing >= PING_EVERY then tx.sincePing = 0; pcall(pingHub) end

  local fwd, right = basis()
  local vel = obj:getVelocity()
  kin.vel, kin.speed = vel, vel:length()
  updateAccel(dt, vel, fwd, right)
  updateYaw(dt, fwd, right)
  local k = clamp(dt * TRAVEL_SMOOTH_HZ, 0, 1)
  local origin = obj:getPosition()
  if lay.front then kin.travel = axleTravel(lay.front, kin.travel, "front", vel, origin, fwd, right, k) end
  if lay.rear then kin.rearTravel = axleTravel(lay.rear, kin.rearTravel, "rear", vel, origin, fwd, right, k) end
  diag.physYaw, diag.headYaw = kin.physYaw, kin.headYaw
  if watch.travel > 0 then travelDumpStep(dt) end

  -- capture the wheel layout once, ideally with the steering centred
  if not lay.wheels then
    lay.wait = lay.wait + dt
    local steerIn = math.abs(electrics.values.steering_input or 0)
    if steerIn < CENTRE_INPUT then captureLayout(fwd, right, true)
    elseif lay.wait > 1.5 then captureLayout(fwd, right, false)
    else return end
  end

  local ev = electrics.values
  updateAssists(ev)
  updateSourceCuts(ev)
  local hasGraph = updateGraph()
  updateWheels(dt, fwd, right, kin.speed, ev, hasGraph)
  updateTravel(dt, fwd, right, ev)
  if uiWantsFrame() then send(fwd, right, ev) end
end

-- BeamNG switches a vehicle off when one of its scripts throws an error, so everything this
-- extension does runs protected: a problem in the display can only stop the display, never
-- the car. Errors are logged (at most every 10 s, with where they happened) so they can be
-- reported and fixed.
local errLog = { next = 0, count = 0 }
local function protect(where, fn, ...)
  local ok, err = pcall(fn, ...)
  if ok then return true end
  errLog.count = errLog.count + 1
  if clock >= errLog.next or errLog.count == 1 then
    errLog.next = clock + 10
    log('E', 'vgsTelemetry', string.format('%s failed (%d times so far): %s', where, errLog.count, tostring(err)))
  end
  return false
end

local function updateGFX(dt)
  if not protect('update', step, dt) and active then
    -- start afresh next frame: a half-finished update can leave estimates in a bad state
    pcall(resetState)
  end
end

local function setActive(on)
  on = on and true or false
  if on and not active then protect('start', resetState) end
  active = on
end

-- Numbers mode: work out and send the extra values
local function setDetail(on) detail = on and true or false end
-- Send the layout with the next update (the app asks when it doesn't have it)
local function requestLayout() tx.staticDue = true end

-- Couplers (fifth wheel, tow hitch, articulation joints between separate vehicles)
local function onCouplerAttached(nodeId, obj2id)
  if type(obj2id) == "number" and obj2id ~= obj:getId() then
    coupled[obj2id] = (coupled[obj2id] or 0) + 1
    tx.sincePing = PING_EVERY   -- tell the hub straight away
  end
end
local function onCouplerDetached(nodeId, obj2id)
  if type(obj2id) == "number" and coupled[obj2id] then
    coupled[obj2id] = coupled[obj2id] - 1
    if coupled[obj2id] <= 0 then coupled[obj2id] = nil end
    tx.sincePing = PING_EVERY
  end
end

local function dumpWheels()
  local fwd, right = basis()
  forEachWheel(function(i, w)
    local okT, tyres, offset, reason, radius, width = pcall(tyreInfo, i, w)
    local _, p1, p2 = axleYaw(w, fwd, right)
    local mid = (p1 + p2) * 0.5
    local d = wheelJbeam(i, w) or {}
    say(string.format(
      "[%d] %s  nodes %s/%s  x=%.2f y=%.2f  radius=%s width=%s offset=%s  tyres=%s (%s)  group=%s hubGroup=%s",
      i, tostring(w.name), tostring(w.node1), tostring(w.node2), mid:dot(right), mid:dot(fwd),
      tostring(radius), tostring(width), tostring(offset), okT and tostring(tyres) or "error",
      tostring(okT and (reason or "single") or tyres), tostring(d.group or w.group), tostring(d.hubGroup or w.hubGroup)))
  end)
end

local function dumpDrivetrain()
  local devices = (powertrain and powertrain.getDevices) and powertrain.getDevices() or {}
  say("-- powertrain devices --")
  for name, d in pairs(devices) do
    if type(d) == "table" then
      local kids = {}
      for _, c in pairs(type(d.children) == "table" and d.children or {}) do
        if type(c) == "table" then kids[#kids + 1] = tostring(c.name) end
      end
      say(string.format("%s  type=%s visualType=%s diffType=%s mode=%s splitType=%s activeLockCoef=%s broken=%s canDisconnect=%s wheel=%s throttleFactor=%s -> [%s]",
        tostring(name), tostring(d.type), tostring(d.visualType), tostring(d.diffType), tostring(d.mode),
        tostring(d.splitType), tostring(d.activeLockCoef), tostring(d.isBroken), tostring(canDisconnect(d)),
        tostring(d.connectedWheel), tostring(d.throttleFactor), table.concat(kids, ", ")))
    end
  end
  say("-- what the VGS draws --")
  local graph = lay.drivetrain and lay.drivetrain.graph or {}
  if #graph == 0 then say("(nothing yet: open the app with this vehicle first)") end
  for idx, n in ipairs(graph) do
    local cps = {}
    for _, c in ipairs(n.cps or {}) do cps[#cps + 1] = c.kind .. "(" .. tostring(c.dev.name) .. ")" end
    say(string.format("%d. %s %s parent=%d%s%s%s%s", idx, n.k, tostring(n.name or (n.w and ("wheel " .. n.w)) or ""),
      n.p, n.sub and ("  " .. n.sub) or "",
      n.dev and n.k == "diff" and ("  " .. diffTypeName(n.dev) .. ", " .. diffState(n.dev)) or "",
      #cps > 0 and ("  link: " .. table.concat(cps, ", ")) or "",
      n.gx and string.format("  located x=%.2f y=%.2f", n.gx, n.gy) or ""))
  end
end

M.dumpWheels        = function() protect('dumpWheels', dumpWheels) end
M.dumpDrivetrain    = function() protect('dumpDrivetrain', dumpDrivetrain) end
M.dumpAssists       = function() protect('dumpAssists', dumpAssists) end
M.watchAssists      = function(on) watch.assists = on ~= false; watch.assistValues = {} end
M.dumpTravel        = function(seconds) watch.travel, watch.travelNext = tonumber(seconds) or 10, 0 end
M.travelState       = function() return diag, est.lock, kin.travel, kin.rearTravel, kin.yawRate, est.ratio end   -- for tests
M.gripState        = function() return gm, est end   -- for tests
M.onExtensionLoaded = function() protect('load', resetState) end
M.onReset           = function() protect('reset', resetState) end
M.updateGFX         = updateGFX
M.setActive         = setActive
M.setDetail         = setDetail
M.requestLayout     = requestLayout
M.onCouplerAttached = function(...) protect('coupler attached', onCouplerAttached, ...) end
M.onCouplerDetached = function(...) protect('coupler detached', onCouplerDetached, ...) end

return M

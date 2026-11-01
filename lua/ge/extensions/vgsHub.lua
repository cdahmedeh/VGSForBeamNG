-- VGS Display : game-engine hub
-- ---------------------------------------------------------------------------
-- Gathers per-wheel data from the player's vehicle and anything coupled to it
-- (trailers, dollies, the rear section of an articulated bus that is spawned as
-- its own vehicle), orders those bodies front to back, and forwards them to the
-- VGS Display UI app as the 'VGSUpdate' event.
--
-- The UI app loads and enables this extension itself; no modScript needed.
-- ---------------------------------------------------------------------------

local M = {}

local MANAGE_EVERY  = 1 / 30 -- s (real time) between checks of which vehicles to run telemetry on
local KEEPALIVE     = 0.5    -- s (real time): resend the last frame this often when nothing new
                             -- arrives (game paused), so the app doesn't time out and blank
local STALE_AFTER   = 0.6    -- s (sim time) without data before a vehicle is (re)activated
local RETRY_EVERY   = 1.0    -- s (sim time) between activation attempts
local MAX_LINK_DIST = 40     -- m; a "coupled" body further away than this is ignored

local enabled   = false
local simClock  = 0
local latest    = {} -- [vid] = { d = decoded payload, t = simClock }
local activated = {} -- [vid] = simClock of the last activation command
local links     = {} -- [vid] = { [otherVid] = true }, from game-engine coupler hooks
local playerId  = nil
local realClock = 0
local lastSent  = -1

local function getVeh(id)
  local ok, veh = pcall(function() return be:getObjectByID(id) end)
  if ok and veh then return veh end
  if scenetree and scenetree.findObjectById then return scenetree.findObjectById(id) end
end

local function sendToVehicle(vid, cmd)
  local veh = getVeh(vid)
  if veh then veh:queueLuaCommand(cmd) end
end

local function activate(vid)
  sendToVehicle(vid, 'extensions.load("vgsTelemetry") if extensions.vgsTelemetry then extensions.vgsTelemetry.setActive(true) end')
  activated[vid] = simClock
end

local function deactivate(vid)
  sendToVehicle(vid, 'if extensions.vgsTelemetry then extensions.vgsTelemetry.setActive(false) end')
  activated[vid] = nil
  latest[vid] = nil
end

local function addLink(a, b)
  if type(a) ~= "number" or type(b) ~= "number" or a == b then return end
  links[a] = links[a] or {}; links[a][b] = true
  links[b] = links[b] or {}; links[b][a] = true
end

local function removeLink(a, b)
  if links[a] then links[a][b] = nil end
  if links[b] then links[b][a] = nil end
end

-- Union of coupling info from the game-engine hooks and the vehicle's own report.
local function neighbours(vid)
  local set = {}
  if links[vid] then for o in pairs(links[vid]) do set[o] = true end end
  local rec = latest[vid]
  if rec and type(rec.d.c) == "table" then
    for _, o in pairs(rec.d.c) do if type(o) == "number" then set[o] = true end end
  end
  return set
end

local function collectChain(pid)
  local chain, seen, queue, head = {}, { [pid] = true }, { pid }, 1
  while queue[head] do
    local vid = queue[head]; head = head + 1
    chain[#chain + 1] = vid
    for o in pairs(neighbours(vid)) do
      if not seen[o] then seen[o] = true; queue[#queue + 1] = o end
    end
  end
  return chain, seen
end

-- Builds the frame from the latest data of the player's vehicle and everything coupled to it,
-- ordered front to back along the player vehicle's heading, and sends it to the app.
local function sendFrame()
  if not playerId then
    guihooks.trigger('VGSUpdate', { bodies = {} })
    lastSent = realClock
    return
  end
  local pid = playerId
  local chain = collectChain(pid)
  local ref = latest[pid] and latest[pid].d
  local hx, hy = 0, 1
  if ref then
    local l = math.sqrt(ref.hx * ref.hx + ref.hy * ref.hy)
    if l > 1e-6 then hx, hy = ref.hx / l, ref.hy / l end
  end

  local bodies = {}
  for _, vid in ipairs(chain) do
    local rec = latest[vid]
    if rec and simClock - rec.t < STALE_AFTER * 2 then
      local d, along, keep = rec.d, 0, true
      if ref and vid ~= pid then
        local dx, dy = d.px - ref.px, d.py - ref.py
        if math.sqrt(dx * dx + dy * dy) > MAX_LINK_DIST then
          keep = false
        else
          along = dx * hx + dy * hy
        end
      end
      if keep then bodies[#bodies + 1] = { id = vid, along = along, wheels = d.w, sources = d.src, inp = d.inp, gf = d.gf, ext = d.ext, dt = d.dt } end
    end
  end
  table.sort(bodies, function(a, b) return a.along > b.along end)

  guihooks.trigger('VGSUpdate', { bodies = bodies })
  lastSent = realClock
end

local manageTimer = 0
function M.onUpdate(dtReal, dtSim)
  if not enabled then return end
  simClock  = simClock + (dtSim or dtReal or 0)
  realClock = realClock + (dtReal or 0)

  manageTimer = manageTimer + (dtReal or 0)
  if manageTimer >= MANAGE_EVERY then
    manageTimer = 0
    local player = be:getPlayerVehicle(0)
    playerId = player and player:getID() or nil
    if playerId then
      -- keep telemetry running on exactly the vehicles we display
      local chain, inChain = collectChain(playerId)
      for _, vid in ipairs(chain) do
        local rec = latest[vid]
        local fresh = rec and (simClock - rec.t) < STALE_AFTER
        if not fresh and (not activated[vid] or simClock - activated[vid] > RETRY_EVERY) then
          activate(vid)
        end
      end
      for vid in pairs(activated) do
        if not inChain[vid] then deactivate(vid) end
      end
    end
  end

  -- frames normally go out as the player's data arrives (onVehicleJson); this only covers
  -- no player vehicle, and the game being paused
  if realClock - lastSent >= KEEPALIVE then sendFrame() end
end

-- Called from each vehicle's vgsTelemetry extension.
function M.onVehicleJson(str)
  local ok, d = pcall(jsonDecode, str)
  if ok and type(d) == "table" and type(d.id) == "number" then
    latest[d.id] = { d = d, t = simClock }
    -- send as soon as the player's vehicle reports, so every update reaches the app once, with
    -- no extra delay (coupled bodies' latest data rides along)
    if enabled and d.id == playerId then sendFrame() end
  end
end

function M.setEnabled(on)
  on = on and true or false
  if enabled == on then return end
  enabled = on
  if not on then
    for vid in pairs(activated) do deactivate(vid) end
  else
    manageTimer = MANAGE_EVERY   -- find the player's vehicle on the next update
  end
end

-- Diagnostics, runnable from the normal game-engine Lua console (the default "GE - Lua"
-- context). Each one is passed on to the vehicle you're driving, whose output appears in the
-- same console:
--   extensions.vgsHub.dumpAssists()       driver-assist values, once
--   extensions.vgsHub.watchAssists(true)  every assist value change while you drive (false stops)
--   extensions.vgsHub.dumpWheels()        wheel positions, sizes and dual detection
--   extensions.vgsHub.dumpDrivetrain()    the powertrain devices and what the VGS draws
--   extensions.vgsHub.dumpTravel(10)      what's behind the direction marker, 4x a second for 10 s
local function toPlayerVehicle(call)
  local veh = be:getPlayerVehicle(0)
  if not veh then log('W', 'vgsHub', 'no player vehicle'); return end
  veh:queueLuaCommand('extensions.load("vgsTelemetry") if extensions.vgsTelemetry then extensions.vgsTelemetry.' .. call .. ' end')
end
function M.dumpAssists() toPlayerVehicle('dumpAssists()') end
function M.watchAssists(on) toPlayerVehicle('watchAssists(' .. tostring(on ~= false) .. ')') end
function M.dumpWheels() toPlayerVehicle('dumpWheels()') end
function M.dumpDrivetrain() toPlayerVehicle('dumpDrivetrain()') end
function M.dumpTravel(seconds) toPlayerVehicle('dumpTravel(' .. (tonumber(seconds) or 10) .. ')') end

-- Game-engine coupler hooks (objId1 and objId2 are the two vehicles involved).
function M.onCouplerAttached(objId1, objId2) addLink(objId1, objId2) end
function M.onCouplerDetached(objId1, objId2) removeLink(objId1, objId2) end

function M.onVehicleDestroyed(vid)
  latest[vid], activated[vid] = nil, nil
  if links[vid] then
    for o in pairs(links[vid]) do if links[o] then links[o][vid] = nil end end
    links[vid] = nil
  end
end

function M.onExtensionLoaded()
  -- stay loaded across level changes; the UI app also re-enables us if needed
  if setExtensionUnloadMode then pcall(setExtensionUnloadMode, M, "manual") end
end

return M

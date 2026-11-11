-- VGS Display : game-engine hub
-- ---------------------------------------------------------------------------
-- Keeps the vehicle-side telemetry (vgsTelemetry) running on exactly the vehicles the app
-- shows: the player's vehicle and anything coupled to it (trailers, dollies, the rear section
-- of an articulated bus that is spawned as its own vehicle).
--
-- The vehicles send their data straight to the app (the 'VGSData' UI hook); this hub only
-- tells the app which vehicles make up the player's chain ('VGSChain', a few times a second,
-- which also tells it the game is still there while paused), passes the app's requests on to
-- the vehicles, and forwards data from vehicles that can't reach the UI directly.
--
-- The UI app loads and enables this extension itself; no modScript needed.
-- ---------------------------------------------------------------------------

local M = {}

local MANAGE_EVERY  = 1 / 30 -- s (real time) between checks of which vehicles to run telemetry on
local CHAIN_EVERY   = 0.25   -- s (real time) between 'VGSChain' messages (also sent on any change)
local STALE_AFTER   = 1.5    -- s (sim time) without a ping before a vehicle is (re)activated
local RETRY_EVERY   = 1.0    -- s (sim time) between activation attempts

local enabled    = false
local detail     = false     -- the app is open: the vehicles send the balance's degrees
local simClock   = 0
local realClock  = 0
local pings      = {}        -- [vid] = simClock of its last ping
local reported   = {}        -- [vid] = { otherVid, ... } couplings the vehicle itself reports
local activated  = {}        -- [vid] = simClock of the last activation command
local links      = {}        -- [vid] = { [otherVid] = true }, from game-engine coupler hooks
local playerId   = nil
local manageTimer, chainTimer = 0, 0
local lastChainKey = nil

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
  sendToVehicle(vid, 'extensions.load("vgsTelemetry") if extensions.vgsTelemetry then ' ..
    'extensions.vgsTelemetry.setDetail(' .. tostring(detail) .. ') extensions.vgsTelemetry.setActive(true) end')
  activated[vid] = simClock
end

local function deactivate(vid)
  sendToVehicle(vid, 'if extensions.vgsTelemetry then extensions.vgsTelemetry.setActive(false) end')
  activated[vid], pings[vid], reported[vid] = nil, nil, nil
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

-- coupling info from the game-engine hooks, the game's trailer register and the vehicles themselves
local trailerReg = nil
local function neighbours(vid)
  local set = {}
  if links[vid] then for o in pairs(links[vid]) do set[o] = true end end
  if trailerReg then   -- core_trailerRespawn: [vehicle] = { trailerId = the vehicle coupled behind it }
    local own = trailerReg[vid]
    if type(own) == "table" and type(own.trailerId) == "number" then set[own.trailerId] = true end
    for o, rec in pairs(trailerReg) do
      if type(rec) == "table" and rec.trailerId == vid and type(o) == "number" then set[o] = true end
    end
  end
  if reported[vid] then for _, o in ipairs(reported[vid]) do set[o] = true end end
  for o, list in pairs(reported) do   -- either side reporting the coupling is enough
    for _, x in ipairs(list) do if x == vid then set[o] = true end end
  end
  return set
end

local function collectChain(pid)
  local chain, seen, queue, head = {}, { [pid] = true }, { pid }, 1
  while queue[head] do
    local vid = queue[head]; head = head + 1
    if vid == pid or getVeh(vid) then
      chain[#chain + 1] = vid
      for o in pairs(neighbours(vid)) do
        if not seen[o] then seen[o] = true; queue[#queue + 1] = o end
      end
    end
  end
  return chain, seen
end

local function sendChain(chain)
  local key = tostring(playerId) .. ":" .. table.concat(chain or {}, ",")
  if key == lastChainKey and chainTimer < CHAIN_EVERY then return end
  lastChainKey, chainTimer = key, 0
  guihooks.trigger('VGSChain', { p = playerId or -1, ch = chain or {} })
end

function M.onUpdate(dtReal, dtSim)
  if not enabled then return end
  simClock  = simClock + (dtSim or dtReal or 0)
  realClock = realClock + (dtReal or 0)
  manageTimer = manageTimer + (dtReal or 0)
  chainTimer = chainTimer + (dtReal or 0)
  if manageTimer < MANAGE_EVERY then return end
  manageTimer = 0

  local player = be:getPlayerVehicle(0)
  playerId = player and player:getID() or nil
  trailerReg = nil
  if core_trailerRespawn and core_trailerRespawn.getTrailerData then
    local okT, reg = pcall(core_trailerRespawn.getTrailerData)
    if okT and type(reg) == "table" then trailerReg = reg end
  end
  local chain = {}
  if playerId then
    local inChain
    chain, inChain = collectChain(playerId)
    for _, vid in ipairs(chain) do
      local fresh = pings[vid] and (simClock - pings[vid]) < STALE_AFTER
      if not fresh and (not activated[vid] or simClock - activated[vid] > RETRY_EVERY) then activate(vid) end
    end
    for vid in pairs(activated) do
      if not inChain[vid] then deactivate(vid) end
    end
  else
    for vid in pairs(activated) do deactivate(vid) end
  end
  sendChain(chain)
end

-- From each vehicle's telemetry, twice a second: it's running, and what it's coupled to.
function M.onVehiclePing(vid, coupledTo)
  if type(vid) ~= "number" then return end
  pings[vid] = simClock
  reported[vid] = type(coupledTo) == "table" and coupledTo or {}
end

-- Vehicles that can't trigger UI hooks themselves (older game versions) send through here.
function M.onVehicleJson(str)
  local ok, d = pcall(jsonDecode, str)
  if ok and type(d) == "table" and type(d.id) == "number" then
    pings[d.id] = simClock
    if enabled then guihooks.trigger('VGSData', d) end
  end
end

function M.setEnabled(on)
  on = on and true or false
  if enabled == on then
    if on then lastChainKey = nil end   -- a new app instance: tell it the chain straight away
    return
  end
  enabled = on
  if not on then
    for vid in pairs(activated) do deactivate(vid) end
  else
    manageTimer, lastChainKey = MANAGE_EVERY, nil   -- find the player's vehicle on the next update
  end
end

-- While the app is open the vehicles work out and send the balance's degrees (vd).
function M.setDetail(on)
  detail = on and true or false
  for vid in pairs(activated) do
    sendToVehicle(vid, 'if extensions.vgsTelemetry then extensions.vgsTelemetry.setDetail(' .. tostring(detail) .. ') end')
  end
end

-- The app has data from a vehicle but not its layout (the app was reloaded): resend it.
function M.requestLayout(vid)
  local targets = {}
  if type(vid) == "number" then targets[1] = vid else for id in pairs(activated) do targets[#targets + 1] = id end end
  for _, id in ipairs(targets) do
    sendToVehicle(id, 'if extensions.vgsTelemetry then extensions.vgsTelemetry.requestLayout() end')
  end
end

-- Diagnostics, runnable from the normal game-engine Lua console (the default "GE - Lua"
-- context). Each is passed on to the vehicle you're driving, whose output appears in the
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

-- Game-engine coupler hooks (objId1 and objId2 are the two vehicles involved)
function M.onCouplerAttached(objId1, objId2) addLink(objId1, objId2) end
function M.onCouplerDetached(objId1, objId2) removeLink(objId1, objId2) end

function M.onVehicleDestroyed(vid)
  pings[vid], activated[vid], reported[vid] = nil, nil, nil
  if links[vid] then
    for o in pairs(links[vid]) do if links[o] then links[o][vid] = nil end end
    links[vid] = nil
  end
end

function M.onExtensionLoaded()
  -- stay loaded across level changes; the UI app also re-enables us if needed
  if setExtensionUnloadMode then pcall(setExtensionUnloadMode, M, "manual") end
end

M.state = function() return { enabled = enabled, player = playerId, activated = activated, pings = pings, detail = detail } end   -- for tests

return M

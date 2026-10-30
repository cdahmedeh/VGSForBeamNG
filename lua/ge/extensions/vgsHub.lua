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

local SEND_INTERVAL = 1 / 60 -- s (real time) between UI updates (capped by the game's frame rate)
local STALE_AFTER   = 0.6    -- s (sim time) without data before a vehicle is (re)activated
local RETRY_EVERY   = 1.0    -- s (sim time) between activation attempts
local MAX_LINK_DIST = 40     -- m; a "coupled" body further away than this is ignored

local enabled   = false
local simClock  = 0
local sendTimer = 0
local latest    = {} -- [vid] = { d = decoded payload, t = simClock }
local activated = {} -- [vid] = simClock of the last activation command
local links     = {} -- [vid] = { [otherVid] = true }, from game-engine coupler hooks

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

function M.onUpdate(dtReal, dtSim)
  if not enabled then return end
  simClock  = simClock + (dtSim or dtReal or 0)
  -- keep the leftover time, so a frame that lands a hair early doesn't halve the rate
  sendTimer = sendTimer + (dtReal or 0)
  if sendTimer < SEND_INTERVAL * 0.95 then return end
  sendTimer = sendTimer - SEND_INTERVAL
  if sendTimer > SEND_INTERVAL or sendTimer < 0 then sendTimer = 0 end

  local player = be:getPlayerVehicle(0)
  if not player then
    guihooks.trigger('VGSUpdate', { bodies = {} })
    return
  end
  local pid = player:getID()
  local chain, inChain = collectChain(pid)

  -- Keep telemetry running on exactly the vehicles we display.
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

  -- Order bodies front-to-back along the player vehicle's heading.
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
end

-- Called from each vehicle's vgsTelemetry extension.
function M.onVehicleJson(str)
  local ok, d = pcall(jsonDecode, str)
  if ok and type(d) == "table" and type(d.id) == "number" then
    latest[d.id] = { d = d, t = simClock }
  end
end

function M.setEnabled(on)
  on = on and true or false
  if enabled == on then return end
  enabled = on
  if not on then
    for vid in pairs(activated) do deactivate(vid) end
  end
end

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

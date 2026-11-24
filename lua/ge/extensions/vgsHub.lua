-- VGS Display : game-engine hub
-- ---------------------------------------------------------------------------
-- Keeps the vehicle-side telemetry (vgsTelemetry) running on exactly the vehicles the app
-- shows: the player's vehicle and anything coupled to it (trailers, dollies, the rear section
-- of an articulated bus that is spawned as its own vehicle).
--
-- Two ways of drawing (the renderer, 'VGSChain' tells the app which):
--   lua  every vehicle sends its updates here, every frame; the moving parts are drawn here
--        (vgs/draw.lua) in an ImGui window laid over the app, at the game's frame rate, and
--        the app draws only the parts that change with the layout. The app is sent each
--        vehicle's layout and a few updates a second, all it needs to lay the picture out.
--   cef  the app draws everything (the fallback, and how 1.x worked): the player's vehicle
--        sends straight to the app, any other vehicle through here (BeamNG only reliably
--        delivers a vehicle's own UI messages from the vehicle the player is in).
-- 'lua' is used whenever the game's ImGui is there; a drawing error switches to 'cef' for the
-- rest of the session. extensions.vgsHub.setRenderer('cef' | 'lua' | 'auto') picks one for good.
--
-- The hub also tells the app which vehicles make up the player's chain ('VGSChain', a few
-- times a second, which also tells it the game is still there while paused) and passes the
-- app's requests on to the vehicles.
--
-- The UI app loads and enables this extension itself; no modScript needed.
-- ---------------------------------------------------------------------------

local M = {}

local MANAGE_EVERY  = 1 / 30 -- s (real time) between checks of which vehicles to run telemetry on
local CHAIN_EVERY   = 0.25   -- s (real time) between 'VGSChain' messages (also sent on any change)
local STALE_AFTER   = 1.5    -- s (sim time) without a ping before a vehicle is (re)activated
local RETRY_EVERY   = 1.0    -- s (sim time) between activation attempts
local FORWARD_EVERY = 0.25   -- s (real time): with the game engine drawing, how often each vehicle's update goes on to the app
local PLACE_TIMEOUT = 1.5    -- s (real time): an app that hasn't said where it is for this long isn't drawn
local MAX_ERRORS    = 3      -- drawing errors before falling back to the app's own renderer
local EDGE          = 4      -- px of room round the app in the overlay window, so strokes on its edge aren't clipped
local SETTINGS_FILE = "settings/vgsDisplay.json"

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

-- Rendering
local draw = nil             -- vgs/draw.lua, once loaded
local renderer = 'cef'       -- 'lua' or 'cef' (see the top)
local preference = 'auto'    -- 'auto', 'lua' or 'cef' (setRenderer, kept in SETTINGS_FILE)
local failure = nil          -- why the game-engine renderer was given up this session
local errors = 0
local live = {}              -- [vid] = its latest update (decoded)
local forwarded = {}         -- [vid] = { t = realClock, lv } of the last update passed on to the app
local views = {}             -- [key] = { scene, place = { x, y, w, h, vis, t }, state }: each app on screen
local gfx = nil

local function getVeh(id)
  local ok, veh = pcall(function() return be:getObjectByID(id) end)
  if ok and veh then return veh end
  if scenetree and scenetree.findObjectById then return scenetree.findObjectById(id) end
end

local function sendToVehicle(vid, cmd)
  local veh = getVeh(vid)
  if veh then veh:queueLuaCommand(cmd) end
end

-- Every surface's peak grip against tarmac's, by ground-model ID (the ID BeamNG gives each wheel
-- for what it's touching), for the grip bars: a tyre on ice has less grip to use than one on
-- tarmac. Read from the game's ground models: their static friction over ASPHALT's. Built once
-- per level.
local REF_SURFACE, REF_FRICTION = 'ASPHALT', 0.92   -- tarmac, and its friction if it can't be read
local surfaceCmd = nil
local function surfacesCmd()
  if surfaceCmd then return surfaceCmd end
  if not (be and be.getGroundModelCount and be.getGroundModelByID) then return '' end
  local ref = REF_FRICTION
  local okR, r = pcall(function() return core_environment.groundModels[REF_SURFACE].cdata.staticFrictionCoefficient end)
  if okR and tonumber(r) and tonumber(r) > 0.05 then ref = tonumber(r) end
  local okN, n = pcall(be.getGroundModelCount, be)
  if not okN or type(n) ~= "number" then return '' end
  local parts = {}
  for i = 0, n do
    local okG, gm = pcall(be.getGroundModelByID, be, i)
    local d = okG and gm and gm.data
    local f = d and tonumber(d.staticFrictionCoefficient)
    if f and f > 0 then parts[#parts + 1] = string.format("[%d]=%.3f", i, f / ref) end
  end
  if #parts == 0 then return '' end
  surfaceCmd = ' if extensions.vgsTelemetry and extensions.vgsTelemetry.setSurfaces then extensions.vgsTelemetry.setSurfaces({' ..
    table.concat(parts, ',') .. '}) end'
  return surfaceCmd
end

-- With the game engine drawing, every vehicle sends every frame, through here.
local function routeCmd()
  return 'if extensions.vgsTelemetry and extensions.vgsTelemetry.setRoute then extensions.vgsTelemetry.setRoute(' ..
    tostring(renderer == 'lua') .. ') end'
end

local function activate(vid)
  sendToVehicle(vid, 'extensions.load("vgsTelemetry") if extensions.vgsTelemetry then ' ..
    'extensions.vgsTelemetry.setDetail(' .. tostring(detail) .. ') extensions.vgsTelemetry.setActive(true) end ' .. routeCmd() .. surfacesCmd())
  activated[vid] = simClock
end

local function deactivate(vid)
  sendToVehicle(vid, 'if extensions.vgsTelemetry then extensions.vgsTelemetry.setActive(false) end')
  activated[vid], pings[vid], reported[vid], live[vid], forwarded[vid] = nil, nil, nil, nil, nil
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
  guihooks.trigger('VGSChain', { p = playerId or -1, ch = chain or {}, r = renderer })
end

-- ===== The game-engine renderer =============================================

local function imgui()
  if ui_imgui then return ui_imgui end
  if extensions and extensions.load then pcall(extensions.load, 'ui_imgui') end
  return rawget(_G, 'ui_imgui')
end

local function loadDraw()
  if draw then return draw end
  local ok, mod = pcall(require, 'vgs/draw')
  if ok and type(mod) == 'table' and mod.draw and mod.imguiGfx then draw = mod end
  return draw
end

-- Which renderer to use now: the preference, unless the game-engine one can't work here.
local function chooseRenderer()
  local want = preference
  if want == 'auto' then want = 'lua' end
  if want == 'lua' and (failure or not imgui() or not loadDraw()) then want = 'cef' end
  return want
end

local function setRendererNow(r, why)
  if r == renderer then return end
  renderer = r
  log('I', 'vgsHub', 'drawing with the ' .. (r == 'lua' and 'game-engine renderer' or "app's own renderer") .. (why and (' (' .. why .. ')') or ''))
  local cmd = routeCmd()
  for vid in pairs(activated) do sendToVehicle(vid, cmd) end
  for vid in pairs(forwarded) do forwarded[vid] = nil end
  lastChainKey = nil   -- tell the app straight away
end

local function readPreference()
  local ok, t = pcall(jsonReadFile, SETTINGS_FILE)
  if ok and type(t) == 'table' and (t.renderer == 'lua' or t.renderer == 'cef' or t.renderer == 'auto') then preference = t.renderer end
end

-- Where the game's window is: the canvas's size and, with ImGui's viewports on, its position
-- on the desktop (ImGui then works in desktop coordinates), as the minimap does.
local point00, canvasObj = nil, nil
local function canvasRect(im)
  -- looked up once (each lookup allocates), again if it stops answering
  canvasObj = canvasObj or (scenetree and scenetree.findObject and scenetree.findObject("Canvas"))
  local canvas = canvasObj
  if not canvas or not canvas.getWindowClientSizeXY then canvasObj = nil; return nil end
  local okS, w, h = pcall(canvas.getWindowClientSizeXY, canvas)
  if not okS then canvasObj = nil; return nil end
  if not w or not h or w <= 0 or h <= 0 then return nil end
  local x, y = 0, 0
  local okV, vp = pcall(im.GetConfigFlagsViewportsEnable)
  if okV and vp then
    if not canvas.clientToScreenXY then return nil end
    point00 = point00 or Point2I(0, 0)
    x, y = canvas:clientToScreenXY(point00)
    if not x or not y then return nil end
  end
  return x, y, w, h
end

local windowFlags = nil
local function drawViews(nowMs)
  local im = imgui()
  if not im or not draw then return end
  if editor and editor.active then return end
  if ui_visibility and ui_visibility.getCef and ui_visibility.getCef() == false then return end
  local cx, cy, cw, ch
  for key, v in pairs(views) do
    local pl, sc = v.place, v.scene
    if pl and sc and pl.vis and realClock - pl.t < PLACE_TIMEOUT and type(sc.b) == 'table' and #sc.b > 0
       and (tonumber(sc.w) or 0) > 0 and pl.w > 0 and pl.h > 0 then
      if not cx then
        cx, cy, cw, ch = canvasRect(im)
        if not cx then return end
      end
      gfx = gfx or draw.imguiGfx(im)
      windowFlags = windowFlags or bit.bor(im.WindowFlags_NoScrollbar, im.WindowFlags_NoScrollWithMouse,
        im.WindowFlags_NoTitleBar, im.WindowFlags_NoResize, im.WindowFlags_NoMove, im.WindowFlags_NoInputs,
        im.WindowFlags_NoBackground, im.WindowFlags_NoFocusOnAppearing, im.WindowFlags_NoBringToFrontOnFocus,
        im.WindowFlags_NoNav, im.WindowFlags_NoSavedSettings)
      local x, y, w, h = cx + pl.x * cw, cy + pl.y * ch, pl.w * cw, pl.h * ch
      local k = w / sc.w
      im.SetNextWindowPos(im.ImVec2(x - EDGE, y - EDGE), im.Cond_Always, im.ImVec2(0, 0))
      im.SetNextWindowSize(im.ImVec2(w + 2 * EDGE, h + 2 * EDGE), im.Cond_Always)
      if im.SetNextWindowViewport and im.GetMainViewport then
        local okM, mv = pcall(im.GetMainViewport)
        if okM and mv then pcall(im.SetNextWindowViewport, mv.ID) end
      end
      im.PushStyleVar2(im.StyleVar_WindowPadding, im.ImVec2(0, 0))
      im.PushStyleVar1(im.StyleVar_WindowBorderSize, 0)
      local okB = pcall(im.Begin, '##vgsDisplay_' .. key, nil, windowFlags)
      local ok, err = true, nil
      if okB then
        ok, err = pcall(function()
          gfx.begin(im.GetWindowDrawList(), x, y, k, k / math.max(0.25, tonumber(sc.dpr) or 1))
          draw.draw(gfx, v.state, sc, live, nowMs)
        end)
        im.End()
      else
        ok, err = false, 'could not open the overlay window'
      end
      im.PopStyleVar(2)
      if not ok then
        errors = errors + 1
        log('E', 'vgsHub', 'drawing failed (' .. errors .. '): ' .. tostring(err))
        if errors >= MAX_ERRORS then
          failure = tostring(err)
          setRendererNow('cef', 'the game-engine renderer failed; the app draws everything')
          return
        end
      end
    end
  end
end

local function manage()

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

function M.onUpdate(dtReal, dtSim)
  if not enabled then return end
  simClock  = simClock + (dtSim or dtReal or 0)
  realClock = realClock + (dtReal or 0)
  manageTimer = manageTimer + (dtReal or 0)
  chainTimer = chainTimer + (dtReal or 0)
  if manageTimer >= MANAGE_EVERY then
    manageTimer = 0
    manage()
  end
  if renderer == 'lua' then drawViews(realClock * 1000) end
end

-- From each vehicle's telemetry, twice a second: it's running, and what it's coupled to.
function M.onVehiclePing(vid, coupledTo)
  if type(vid) ~= "number" then return end
  pings[vid] = simClock
  reported[vid] = type(coupledTo) == "table" and coupledTo or {}
end

-- Vehicles the player isn't in send their updates through here: BeamNG only reliably delivers a
-- vehicle's own UI messages from the vehicle the player is in. Passed on as it came, already JSON.
local function toApp(str, d)
  if guihooks.triggerRawJS then
    guihooks.triggerRawJS('VGSData', str)
  else
    if d == nil then
      local ok, dd = pcall(jsonDecode, str)
      d = ok and dd or nil
    end
    if type(d) == "table" then guihooks.trigger('VGSData', d) end
  end
end

-- Updates sent through the hub, as JSON. With the game engine drawing, every vehicle sends every
-- update here: it's kept for drawing, and passed on to the app when it carries the layout, when
-- the layout has changed (a reset) and otherwise every FORWARD_EVERY seconds. Otherwise only
-- vehicles the player isn't in send here, and everything goes on to the app as it came.
function M.onVehicleRaw(vid, str)
  if type(vid) ~= "number" or type(str) ~= "string" then return end
  pings[vid] = simClock
  if not enabled then return end
  if renderer ~= 'lua' then toApp(str); return end
  local ok, d = pcall(jsonDecode, str)
  if not ok or type(d) ~= "table" then return end
  live[vid] = d
  local f = forwarded[vid]
  if d.st ~= nil or not f or f.lv ~= d.lv or realClock - f.t >= FORWARD_EVERY then
    forwarded[vid] = { t = realClock, lv = d.lv }
    toApp(str, d)
  end
end

-- Older builds of the vehicle script send through here.
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
    views = {}
  else
    readPreference()
    setRendererNow(chooseRenderer())
    manageTimer, lastChainKey = MANAGE_EVERY, nil   -- find the player's vehicle on the next update
  end
end

-- ===== From the app (each app on screen has its own key) ============================

local function view(key)
  key = tostring(key)
  local v = views[key]
  if not v then
    v = { state = draw and draw.newView() or nil }
    views[key] = v
  end
  if not v.state and draw then v.state = draw.newView() end
  return v
end

-- The scene the app has laid out (JSON, see sceneOf in app.js): sent when the layout changes.
function M.setScene(key, json)
  if type(json) ~= "string" then return end
  local ok, sc = pcall(jsonDecode, json)
  if not ok or type(sc) ~= "table" then return end
  view(key).scene = sc
end

-- Where the app is, as fractions of the game's window, and whether it's showing (the UI hidden,
-- a menu open, the app not on screen). Sent when it changes and twice a second.
function M.place(key, x, y, w, h, vis)
  x, y, w, h = tonumber(x), tonumber(y), tonumber(w), tonumber(h)
  if not (x and y and w and h) then return end
  local v = view(key)
  v.place = v.place or {}
  local p = v.place
  p.x, p.y, p.w, p.h, p.vis, p.t = x, y, w, h, vis ~= false, realClock
end

-- The app closed, or switched to drawing everything itself.
function M.dropView(key) views[tostring(key)] = nil end

-- Pick the renderer for good: 'lua' (the game engine draws the moving parts), 'cef' (the app
-- draws everything) or 'auto' (the game engine when it can). Kept in settings/vgsDisplay.json.
function M.setRenderer(r)
  if r ~= 'lua' and r ~= 'cef' and r ~= 'auto' then
    log('W', 'vgsHub', "setRenderer: use 'lua', 'cef' or 'auto'")
    return
  end
  preference = r
  if r ~= 'cef' then failure, errors = nil, 0 end   -- try again
  pcall(jsonWriteFile, SETTINGS_FILE, { renderer = r }, true)
  setRendererNow(chooseRenderer(), 'setRenderer')
  print('VGS Display: renderer ' .. preference .. ', drawing with ' .. (renderer == 'lua' and 'the game engine' or 'the app'))
end
function M.getRenderer() return renderer, preference, failure end

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
-- A new level brings its own ground models: read them again, and tell the running vehicles.
function M.onClientPostStartMission()
  surfaceCmd = nil
  local cmd = surfacesCmd()
  if cmd ~= '' then for vid in pairs(activated) do sendToVehicle(vid, cmd) end end
end

function M.onCouplerAttached(objId1, objId2) addLink(objId1, objId2) end
function M.onCouplerDetached(objId1, objId2) removeLink(objId1, objId2) end

function M.onVehicleDestroyed(vid)
  pings[vid], activated[vid], reported[vid], live[vid], forwarded[vid] = nil, nil, nil, nil, nil
  if links[vid] then
    for o in pairs(links[vid]) do if links[o] then links[o][vid] = nil end end
    links[vid] = nil
  end
end

function M.onExtensionLoaded()
  -- stay loaded across level changes; the UI app also re-enables us if needed
  if setExtensionUnloadMode then pcall(setExtensionUnloadMode, M, "manual") end
end

M.state = function() return { enabled = enabled, player = playerId, activated = activated, pings = pings, detail = detail,
  renderer = renderer, preference = preference, failure = failure, errors = errors, live = live, views = views } end   -- for tests

return M

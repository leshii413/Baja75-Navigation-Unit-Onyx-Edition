-- Tread XL GPS (Baja75): full build, Chase Edition and Rally Edition - game-engine side, LuaJIT.
-- Extension name: TreadXLGPS (auto-loaded by scripts/TreadXLGPS/modScript.lua).
--
-- Lua owns all the logic; the UI app only draws what arrives on these guihooks:
--   TreadXLGPS.hud          10 Hz: position, speed, heading, course progress, next waypoints, alert, chase
--   TreadXLGPS.list         saved courses for the current map
--   TreadXLGPS.course       the loaded course (line + waypoints), or { name = nil } when unloaded
--   TreadXLGPS.wpts         waypoint list changed (mark / delete) for the loaded course or recording
--   TreadXLGPS.trail        recorded track points (reset or appended, ~1 Hz while recording)
--   TreadXLGPS.rec          recording started / stopped
--   TreadXLGPS.chaseTargets vehicles you can track in Chase mode
--   TreadXLGPS.cmd          input-action commands for the UI (zoom, orientation)
--   TreadXLGPS.toast        short status messages
--   TreadXLGPS.hello        handshake: script version, level, start-up chime
--   TreadXLGPS.courseInfo   notes / picture / best time of one course (MENU > Courses)
--   TreadXLGPS.text         text typed in the game's own typing window
--   TreadXLGPS.pacenoteInfo rally pacenote builder catalogue, co-driver voices, options
-- Rally pacenotes (lua/ge/extensions/TreadXLGPS/pacenotes.lua) use BeamNG's own rally style, voicepacks and intercom.
-- The separate "Tread XL Alerts" HUD app reads hud.alert from TreadXLGPS.hud too.
-- Works in single-player and BeamMP (no server plugin needed: remote players' cars exist locally).

local M = {}

-- rally pacenotes: BeamNG's own pacenote style, co-driver voices and intercom (see TreadXLGPS/pacenotes.lua)
local PN = nil
do
  local ok, mod = pcall(require, '/lua/ge/extensions/TreadXLGPS/pacenotes')
  if ok and type(mod) == 'table' then PN = mod
  elseif log then log('E', 'TreadXLGPS', 'pacenotes module not loaded: ' .. tostring(mod)) end
end

local TAG = 'TreadXLGPS'
local EV = 'TreadXLGPS.'
local ICON_BASE = '/ui/modules/apps/Baja75-GPS/Baja75-GPSicons/'

local VERSION = '3.1.9'

-- where courses live (game virtual paths in the user folder, %LOCALAPPDATA%\BeamNG\BeamNG.drive\current\).
-- Everything stays under settings/ - the folder BeamNG lets mods write to.
local USER_ROOT = '/settings/TreadXLGPS'
local COURSES = USER_ROOT                   -- your recordings:            settings/TreadXLGPS/<map>/<name>.json (+ .wpt.json)
local SERVER = USER_ROOT .. '/server'       -- from a server's client mod:  settings/TreadXLGPS/server/<map>/ (read-only here)
local GPXDIR = USER_ROOT .. '/gpx'          -- GPX export / import:         settings/TreadXLGPS/gpx/<map>/<name>.gpx
local PACK = USER_ROOT .. '/serverpack'     -- zip the CONTENTS of this folder and put it in the server's Resources/Client
local TIMES = USER_ROOT .. '/times'         -- race times:                 settings/TreadXLGPS/times/<map>/<name>.json
local SOUNDS = USER_ROOT .. '/sounds'       -- your own sounds:            settings/TreadXLGPS/sounds/startup.ogg (.wav / .mp3)
local DEFAULT_STARTUP = '/ui/modules/apps/Baja75-GPS/sounds/startup.ogg'
local LEGACY = '/settings/TreadXLGPS'       -- v1 saved straight into LEGACY/ - still listed and loadable
local V21 = '/TreadXLGPS/courses'           -- v2.1's location, in case anything landed there

-- GPX needs latitude/longitude: each map gets a fixed real-world anchor (game metres <-> degrees, reversible)
local GPX_ORIGINS = {
  johnson_valley = { 34.4206, -116.6197 }, utah = { 38.5733, -109.5498 }, west_coast_usa = { 34.0522, -118.2437 },
  east_coast_usa = { 40.3573, -74.6672 }, italy = { 43.1107, 12.3908 }, jungle_rock_island = { 18.2208, -66.5901 },
}
local GPX_DEFAULT_ORIGIN = { 31.8667, -116.5964 } -- Ensenada, B.C.

local HUD_INTERVAL = 0.1      -- s; 10 Hz like the real unit
local TRAIL_INTERVAL = 1.0    -- s between trail pushes while recording
local REC_STEP = 4            -- m between recorded track points
local VCP_RADIUS = 37         -- m; SCORE VCP radius is 120 ft
local OFF_COURSE = 60         -- m from the course line: beyond this the course logic stops following you
local PNK = {                 -- pacenote / warning settings
  OFF_COURSE_ALERT = 15,      -- m from the course line before the OFF COURSE warning (set in Display)
  LEAD = { early = 6.0, normal = 4.5, late = 3.0 }, -- s of driving before a pacenote that the co-driver calls it
  MIN_LEAD = 30,              -- m: never later than this
  ICON = 'Tread_XL_icon_pacenote.svg',
  EDITION = 'onyx',           -- 'full' | 'chase' | 'rally' | 'track' | 'common' | 'free' | 'onyx': which build this zip is (dev/package.py sets it)
  -- the Onyx Edition (road and overland exploration): the symbols it marks (no race symbols)
  ONYX_KINDS = { hazard = true, danger = true, medic = true, note = true, turn = true },
  -- the Chase Edition's only symbols: pits, start / finish, VCPs, speed zone start / end (no pacenotes, hazards, notes)
  CHASE_KINDS = { pit = true, start = true, vcp = true, zone = true, zoneEnd = true },
}
-- does this edition use waypoints of this kind? (other kinds stay in the course files, just unseen)
-- the edition in effect: on a Baja75 server every edition has every feature (v3.1.1), elsewhere the zip's own
function PNK.ed()
  if PNK.EDITION == 'onyx' then return 'onyx' end -- Onyx is its own unit everywhere (nothing to unlock)
  local L = M._lock
  if L and (L.server or L.LIC.adminOn() or ((PNK.EDITION == 'common' or PNK.EDITION == 'free') and L.unlocked())) then return 'full' end
  return PNK.EDITION
end
function PNK.shows(kind) return PNK.ed() ~= 'chase' or PNK.CHASE_KINDS[kind] == true end
local AHEAD_ALERT = 400       -- m; "VCP ahead" / "speed zone ahead" warning distance
local MAX_JUMP = 100          -- m per tick; larger moves are resets/teleports, not driving
local MPS_TO_MPH = 2.2369362920544
local DEFAULT_LIMIT_MPH = 35
local RACE_START_RADIUS = 10  -- m from the start of the course line to arm the race countdown
local RACE_COUNTDOWN = 10     -- s
local RACE_JUMP = 15          -- m: rolling this far from the start during the countdown is a jump start
local RACE_FINISH_BEFORE = 15 -- m: the finish line sits this far before the end of the course line
local RUNS_KEPT = 20          -- race runs kept per course

-- waypoint symbol -> behaviour
local ICON_KIND = {
  ['Tread_XL_icon_checkpoint.svg'] = 'vcp',
  ['Tread_XL_icon_start_finish.svg'] = 'start',
  ['Tread_XL_icon_speedzone.svg'] = 'zone',
  ['Tread_XL_icon_speedzone_end.svg'] = 'zoneEnd',
  ['Tread_XL_icon_stop.svg'] = 'stop',
  ['Tread_XL_icon_repair.svg'] = 'pit',
  ['Tread_XL_icon_health.svg'] = 'medic',
  ['Tread_XL_icon_warning.svg'] = 'hazard',
  ['Tread_XL_icon_death.svg'] = 'danger',
  ['Tread_XL_icon_rock.svg'] = 'hazard',
  ['Tread_XL_icon_tree.svg'] = 'hazard',
  ['Tread_XL_icon_exit.svg'] = 'note',
  ['Tread_XL_icon_mystery.svg'] = 'note',
  ['Tread_XL_icon_turn_left.svg'] = 'turn',
  ['Tread_XL_icon_turn_right.svg'] = 'turn',
  ['Tread_XL_icon_pacenote.svg'] = 'pacenote',
}

-- props that getAllVehicles() returns but nobody wants to chase
local PROP_JBEAMS = {
  cones = true, barrier = true, barrels = true, blockwall = true, bollard = true, gate = true,
  haybale = true, kickplate = true, metal_box = true, metal_ramp = true, piano = true, rocks = true,
  roadsigns = true, sawhorse = true, shipping_container = true, streetlight = true, tirestacks = true,
  tirewall = true, trafficbarrel = true, tube = true, weightpad = true, woodcrate = true, woodplanks = true,
  ball = true, flail = true, christmas_tree = true, inflated_mat = true, testroller = true, unicycle = true,
}

-- ------------------------------------------------------------------ state
local clock = 0
local hudTimer, trailTimer = 0, 0
local me = nil                -- last vehicle sample { x, y, z, speed, heading, dx, dy }
local lastPos = nil           -- for trip distance
local trip, maxSpeed = 0, 0

local course = nil            -- loaded course (see buildCourse)
local track = {}              -- course progress tracker { i = segment }
local progress = nil          -- { s, off, i } on the loaded course
local runStartS = nil         -- race mile where this run started (VCPs before it can't be "missed")
local vcpState = {}           -- wpt id -> 'cleared' | 'missed'
local finished = false
local transient = {}          -- short-lived alerts { alert, untilT }

local rec = nil               -- { name, pts, wpts, dist, sentIdx }
local markDefaults = { icon = 'Tread_XL_icon_checkpoint.svg', label = '', limitMph = DEFAULT_LIMIT_MPH }

local chase = { id = nil, name = nil, interval = 0, snap = nil, snapT = -1e9, track = {} }

-- race timing ("Race This Route"): staging -> countdown -> running -> finished
--   { state, name, source, cdEnd, lastBeep, t0, splits, best, prevS, prevT, result }
local race = nil
local raceClock = 0           -- simulation time (stops while the game is paused)
local soundOn = true
local bootPending = true      -- the start-up chime plays once per level load
local offCourseAlert = PNK.OFF_COURSE_ALERT
local offCourseShown = false  -- hysteresis for the OFF COURSE warning

-- pacenote calls while driving a loaded course
local pnOpts = { calls = 'on', lead = 'normal', voice = nil, native = true, style = 'full' } -- style 'chase': direction-only calls
local pnRun = { idx = 1, lastS = nil, serial = 0, shown = {} }

-- ------------------------------------------------------------------ helpers
local sqrt, floor, abs, atan2, deg = math.sqrt, math.floor, math.abs, math.atan2, math.deg

local function log_(level, msg)
  if log then log(level, TAG, msg) end
end

local function trigger(name, data)
  if guihooks and guihooks.trigger then guihooks.trigger(EV .. name, data) end
end

local function toast(text, level)
  trigger('toast', { text = text, level = level or 'info' })
end

local function r2(v) return floor(v * 100 + 0.5) / 100 end

local function trim(s) return (tostring(s or ''):gsub('^%s+', ''):gsub('%s+$', '')) end

-- file-safe name: letters, digits, - and _ (spaces become _), max 48 chars
local function safeName(s)
  s = trim(s)
  s = s:gsub('%s+', '_')
  s = s:gsub('[^%w%-_]', '')
  if #s > 48 then s = s:sub(1, 48) end
  return s
end

local function safeLabel(s)
  s = trim(s):gsub('[%c]', '')
  if #s > 32 then s = s:sub(1, 32) end
  return s
end

local function safeIcon(s)
  s = tostring(s or '')
  if s:match('^[%w_%-]+%.svg$') then return s end
  return markDefaults.icon
end

local function kindOf(icon) return ICON_KIND[icon] or 'note' end

-- the loaded level's key ('' when none): getCurrentLevelIdentifier(), else the level folder from
-- getMissionFilename() (what BeamMP uses), e.g. '/levels/johnson_valley/main.level.json' -> 'johnson_valley'
local function levelKey()
  local key = ''
  local ok, id = pcall(function() return getCurrentLevelIdentifier and getCurrentLevelIdentifier() end)
  if ok and type(id) == 'string' then key = id end
  if key == '' then
    local okM, mf = pcall(function() return getMissionFilename and getMissionFilename() end)
    if okM and type(mf) == 'string' and mf ~= '' then
      local okN, n = pcall(function() return core_levels and core_levels.getLevelName and core_levels.getLevelName(mf) end)
      if okN and type(n) == 'string' then key = n end
      if key == '' then key = mf:match('levels/([^/]+)') or '' end
    end
  end
  return key:lower()
end

local function levelId()
  local id = safeName(levelKey())
  if id == '' then id = 'nolevel' end
  return id
end

local function inLevel() return levelKey() ~= '' end

local function coursePath(dir, name) return dir .. '/' .. name .. '.json' end
local function wptPath(dir, name) return dir .. '/' .. name .. '.wpt.json' end

local function fileExists(p)
  if not FS then return false end
  local ok, r = pcall(function() return FS:fileExists(p) end)
  return ok and r == true
end

-- create every folder along the path (FS:directoryCreate may not be recursive)
local function ensureDir(dir)
  if not FS then return end
  local acc = ''
  for part in tostring(dir):gmatch('[^/]+') do
    acc = acc .. '/' .. part
    pcall(function() if not FS:directoryExists(acc) then FS:directoryCreate(acc) end end)
  end
end

-- file names (not paths) in one folder. FS:findFiles(path, pattern, depth, files, dirs) is what the game itself
-- uses to list files; FS:directoryList is kept as a second source in case a game version behaves differently.
local function listFiles(dir, pattern)
  local out, seen = {}, {}
  if not FS then return out end
  local function add(list)
    if type(list) ~= 'table' then return end
    for _, f in ipairs(list) do
      local n = tostring(f):match('([^/\\]+)$')
      if n and not seen[n:lower()] and n:match(pattern) then seen[n:lower()] = true; out[#out + 1] = n end
    end
  end
  local ok, files = pcall(function() return FS:findFiles(dir .. '/', '*', 0, true, false) end)
  if ok then add(files) end
  ok, files = pcall(function() return FS:directoryList(dir, false, false) end)
  if ok then add(files) end
  table.sort(out, function(a, b) return a:lower() < b:lower() end)
  return out
end

local function readJson(p)
  if not fileExists(p) then return nil end
  local ok, data = pcall(jsonReadFile, p)
  if ok and type(data) == 'table' then return data end
  return nil
end

local function writeJson(p, data, pretty)
  ensureDir(p:match('^(.*)/[^/]+$') or '/')
  local ok, err = pcall(jsonWriteFile, p, data, pretty and true or false)
  if not ok then log_('E', 'write failed ' .. p .. ': ' .. tostring(err)) end
  return ok
end

local function readText(p)
  if not fileExists(p) or not readFile then return nil end
  local ok, s = pcall(readFile, p)
  if ok and type(s) == 'string' then return s end
  return nil
end

local function writeText(p, text)
  ensureDir(p:match('^(.*)/[^/]+$') or '/')
  if not writeFile then return false end
  local ok, r = pcall(writeFile, p, text)
  return ok and r ~= nil and r ~= false and fileExists(p)
end

local function removeFile(p)
  if FS and fileExists(p) then pcall(function() FS:removeFile(p) end) end
end

-- absolute path of the BeamNG user folder, for showing where files are (nil if the game can't tell us)
local function userFolder()
  local ok, p = pcall(function() return FS and FS.getUserPath and FS:getUserPath() end)
  if ok and type(p) == 'string' and p ~= '' then return p end
  ok, p = pcall(function() return getUserPath and getUserPath() end)
  if ok and type(p) == 'string' and p ~= '' then return p end
  return nil
end

local function openFolder(dir)
  ensureDir(dir)
  local ok = pcall(function() Engine.Platform.exploreFolder(dir .. '/') end)
  return ok
end

local function looksLikePath(p) return type(p) == 'string' and #p > 3 and p:find('[/\\]') ~= nil end

-- where a folder really is on this player's disk (whatever drive / user name / Steam setup they have)
local function realPath(dir)
  ensureDir(dir)
  local ok, p = pcall(function() return FS and FS.getFileRealPath and FS:getFileRealPath(dir) end)
  if ok and looksLikePath(p) then return (p:gsub('\\', '/')) end
  local u = userFolder()
  if looksLikePath(u) then return (u:gsub('\\', '/'):gsub('/$', '') .. dir) end
  return nil
end

-- game sounds: FMOD events ('event:UI_Countdown1') or sound files from the mod / your settings folder
local function playSfx(src, vol)
  if not soundOn or not src then return end
  pcall(function() Engine.Audio.playOnce('AudioGui', src, { volume = vol or 1 }) end)
end

local function startupSoundPath()
  for _, ext in ipairs({ 'ogg', 'wav', 'mp3' }) do
    local p = SOUNDS .. '/startup.' .. ext
    if fileExists(p) then return p end
  end
  return DEFAULT_STARTUP
end

-- the level's air temperature right now (it follows the map's temperature curve through the day); nil if none
local function airTempC()
  local ok, k = pcall(function() return core_environment and core_environment.getTemperatureK and core_environment.getTemperatureK() end)
  k = ok and tonumber(k) or nil
  if not k or k < 150 or k > 400 then return nil end
  return floor((k - 273.15) * 10 + 0.5) / 10
end

-- in-game time of day as seconds since midnight (BeamNG: time 0 = noon), nil when the level has none
local function timeOfDaySeconds()
  local ok, tod = pcall(function() return core_environment and core_environment.getTimeOfDay and core_environment.getTimeOfDay() end)
  if ok and type(tod) == 'table' and tonumber(tod.time) then return floor(((tonumber(tod.time) + 0.5) % 1) * 86400) end
  return nil
end

local function getVehicleById(id)
  if getObjectByID then
    local ok, v = pcall(getObjectByID, id)
    if ok and v then return v end
  end
  if be and be.getObjectByID then
    local ok, v = pcall(function() return be:getObjectByID(id) end)
    if ok and v then return v end
  end
  return nil
end

local function playerVehicle()
  if getPlayerVehicle then
    local ok, v = pcall(getPlayerVehicle, 0)
    if ok and v then return v end
  end
  if be and be.getPlayerVehicle then
    local ok, v = pcall(function() return be:getPlayerVehicle(0) end)
    if ok and v then return v end
  end
  return nil
end

-- position / ground speed / heading (0 = north, clockwise) of any vehicle object
local function sampleVehicle(veh, prevHeading)
  if not veh then return nil end
  local ok, s = pcall(function()
    local p = veh:getPosition()
    local out = { x = p.x, y = p.y, z = p.z or 0, speed = 0, heading = prevHeading or 0 }
    local okV, v = pcall(function() return veh:getVelocity() end)
    if okV and v then
      out.speed = sqrt(v.x * v.x + v.y * v.y)
      out.vx, out.vy = v.x, v.y
    end
    local okD, d = pcall(function() return veh:getDirectionVector() end)
    if okD and d and (d.x ~= 0 or d.y ~= 0) then
      out.dx, out.dy = d.x, d.y
    elseif out.speed > 1 then
      out.dx, out.dy = out.vx / out.speed, out.vy / out.speed
    end
    if out.dx then out.heading = deg(atan2(out.dx, out.dy)) % 360 end
    return out
  end)
  if ok then return s end
  return nil
end

local function bearing(x1, y1, x2, y2) return deg(atan2(x2 - x1, y2 - y1)) % 360 end

-- ------------------------------------------------------------------ course geometry
local function projSeg(c, i, x, y)
  local a, b = c.pts[i], c.pts[i + 1]
  local ex, ey = b.x - a.x, b.y - a.y
  local L2 = ex * ex + ey * ey
  local t = 0
  if L2 > 0 then
    t = ((x - a.x) * ex + (y - a.y) * ey) / L2
    if t < 0 then t = 0 elseif t > 1 then t = 1 end
  end
  local px, py = a.x + ex * t, a.y + ey * t
  local dx, dy = x - px, y - py
  return dx * dx + dy * dy, c.cum[i] + t * sqrt(L2)
end

local function projectRange(c, x, y, i0, i1)
  local bestD, bestS, bestI = math.huge, 0, i0
  for i = i0, i1 do
    local d2, s = projSeg(c, i, x, y)
    if d2 < bestD then bestD, bestS, bestI = d2, s, i end
  end
  return sqrt(bestD), bestS, bestI
end

-- nearest point on the course; a moving window keeps loops / crossings continuous while on course,
-- and anything off course gets a full search (re-acquire after a reset, teleport or shortcut)
local function project(c, tracker, x, y)
  local nSeg = #c.pts - 1
  if nSeg < 1 then return nil end
  if tracker.i then
    local i0 = math.max(1, tracker.i - 25)
    local i1 = math.min(nSeg, tracker.i + 60)
    local d, s, i = projectRange(c, x, y, i0, i1)
    if d <= OFF_COURSE then tracker.i = i; return d, s, i end
  end
  local d, s, i = projectRange(c, x, y, 1, nSeg)
  tracker.i = i
  return d, s, i
end

local function normalizeWpt(w, id)
  if type(w) ~= 'table' then return nil end
  local x, y = tonumber(w.x or w[1]), tonumber(w.y or w[2])
  if not x or not y then return nil end
  local icon = safeIcon(w.icon ~= '' and w.icon or nil)
  local out = {
    id = id, x = x, y = y, z = tonumber(w.z) or 0,
    icon = icon, kind = kindOf(icon),
    label = safeLabel(w.label or ''),
    s = tonumber(w.s),
  }
  if out.kind == 'zone' then
    local lim = tonumber(w.limitMph)
    out.limitMph = (lim and lim >= 5 and lim <= 200) and lim or DEFAULT_LIMIT_MPH
  end
  if out.kind == 'vcp' then
    local r = tonumber(w.radius)
    out.radius = (r and r >= 5 and r <= 500) and r or VCP_RADIUS
  end
  if out.kind == 'pacenote' then
    if not PN then return nil end
    out.pn = PN.normalize(w.pn) or (type(w.pnCode) == 'string' and PN.decode(w.pnCode)) or nil
    if not out.pn then return nil end
    out.auto = w.auto == true or nil
  end
  if out.label == '' then out.label = nil end
  return out
end

local function defaultLabel(w, nByKind)
  if w.label then return w.label end
  local k = w.kind
  nByKind[k] = (nByKind[k] or 0) + 1
  if k == 'vcp' then return 'VCP ' .. nByKind[k] end
  if k == 'zone' then return 'Speed Zone ' .. (w.limitMph or DEFAULT_LIMIT_MPH) end
  if k == 'zoneEnd' then return 'End Zone' end
  if k == 'start' then return nByKind[k] == 1 and 'Start' or 'Finish' end
  if k == 'pit' then return 'Pit ' .. nByKind[k] end
  if k == 'pacenote' then return PN and PN.text(w.pn) or 'Pacenote' end
  if k == 'stop' then return 'Stop ' .. nByKind[k] end
  if k == 'medic' then return 'Medic' end
  if k == 'danger' then return 'Danger' end
  if k == 'hazard' then
    local name = (w.icon or ''):match('icon_(%w+)%.svg$') or 'hazard'
    return name:sub(1, 1):upper() .. name:sub(2)
  end
  return 'Waypoint'
end

-- pts: list of {x,y,z} or {x=,y=,z=}; wpts: list of waypoint tables
local function buildCourse(name, pts, wpts)
  local c = { name = name, pts = {}, cum = {}, length = 0, wpts = {}, sorted = {}, zones = {} }
  for _, p in ipairs(pts or {}) do
    if type(p) == 'table' then
      local x, y = tonumber(p.x or p[1]), tonumber(p.y or p[2])
      if x and y then
        local n = #c.pts
        local last = c.pts[n]
        if n == 0 or (x - last.x) ^ 2 + (y - last.y) ^ 2 > 0.25 then
          c.pts[n + 1] = { x = x, y = y, z = tonumber(p.z or p[3]) or 0 }
        end
      end
    end
  end
  c.cum[1] = 0
  for i = 2, #c.pts do
    local a, b = c.pts[i - 1], c.pts[i]
    c.cum[i] = c.cum[i - 1] + sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2)
  end
  c.length = c.cum[#c.pts] or 0
  c.hasLine = #c.pts >= 2

  for i, w in ipairs(wpts or {}) do
    local nw = normalizeWpt(w, i)
    if nw then c.wpts[#c.wpts + 1] = nw end
  end
  -- ids are positions in the saved file, so deletes map back exactly
  for i, w in ipairs(c.wpts) do w.id = i end

  if c.hasLine then
    local tr = {}
    for _, w in ipairs(c.wpts) do
      if not (w.s and w.s >= 0 and w.s <= c.length + 1) then
        local _, s = project(c, tr, w.x, w.y)
        w.s = s
        tr.i = nil
      end
    end
  end

  for _, w in ipairs(c.wpts) do if PNK.shows(w.kind) then c.sorted[#c.sorted + 1] = w end end
  table.sort(c.sorted, function(a, b)
    if (a.s or 0) == (b.s or 0) then return a.id < b.id end
    return (a.s or 0) < (b.s or 0)
  end)
  local nByKind = {}
  for _, w in ipairs(c.sorted) do w.name = defaultLabel(w, nByKind) end

  -- speed zones: a zone starts at a speed-zone symbol and ends at the next end/zone symbol (or the finish)
  if c.hasLine then
    local open = nil
    for _, w in ipairs(c.sorted) do
      if w.kind == 'zone' then
        if open then open.s1 = w.s; c.zones[#c.zones + 1] = open end
        open = { s0 = w.s, limitMph = w.limitMph, label = w.name }
      elseif w.kind == 'zoneEnd' and open then
        open.s1 = w.s
        c.zones[#c.zones + 1] = open
        open = nil
      end
    end
    if open then open.s1 = c.length; c.zones[#c.zones + 1] = open end
  end
  -- pacenotes in driving order, each with its distance call to the next one and its tiles
  c.pacenotes = {}
  for _, w in ipairs(c.sorted) do
    if w.kind == 'pacenote' and w.pn and (w.s or not c.hasLine) then c.pacenotes[#c.pacenotes + 1] = w end
  end
  if PN then
    local prevLink = false
    for i, w in ipairs(c.pacenotes) do
      local nx = c.pacenotes[i + 1]
      local call, isLink = nil, false
      if nx and w.s and nx.s then call, isLink = PN.distanceCall(math.max(0, nx.s - (w.s + (w.pn.arc or 0)))) end
      w.call, w.link = call, isLink
      w.vis = PN.visual(w.pn, (not isLink) and call or nil, prevLink)
      prevLink = isLink
    end
  end
  return c
end

local function flatPts(pts)
  local flat = {}
  for i, p in ipairs(pts) do
    flat[2 * i - 1] = r2(p.x)
    flat[2 * i] = r2(p.y)
  end
  return flat
end

local function wptsForUi(list)
  local out = {}
  for _, w in ipairs(list) do
    out[#out + 1] = {
      id = w.id, x = r2(w.x), y = r2(w.y), icon = w.icon, kind = w.kind,
      label = w.name or w.label or 'Waypoint', s = w.s and r2(w.s) or nil, limitMph = w.limitMph, radius = w.radius,
      pn = w.pn, vis = w.kind == 'pacenote' and (w.vis or (PN and PN.visual(w.pn))) or nil, auto = w.auto,
    }
  end
  return out
end

local function wptsForFile(list)
  local out = {}
  for _, w in ipairs(list) do
    out[#out + 1] = {
      x = r2(w.x), y = r2(w.y), z = r2(w.z or 0), icon = w.icon, label = w.label or '',
      limitMph = w.limitMph, radius = (w.radius and w.radius ~= VCP_RADIUS) and w.radius or nil,
      s = w.s and r2(w.s) or nil, pn = w.pn, auto = w.auto,
    }
  end
  return out
end

-- ------------------------------------------------------------------ storage
-- A course is (name, source). source: 'mine' (your folder), 'server' (shipped in a client mod, read-only),
-- 'legacy' (older versions' /settings/TreadXLGPS locations, still editable).
local SOURCES = { 'mine', 'rally', 'server', 'legacy' }

local function sourceDirs(source)
  local map = levelId()
  if source == 'mine' then return { COURSES .. '/' .. map } end
  if source == 'server' then return { SERVER .. '/' .. map } end
  if source == 'rally' then return { '/gameplay/baja75/courses/' .. map } end -- Rally Courses: routes shipped in the mod (read-only; none yet)
  if source == 'legacy' then
    local dirs = { LEGACY, V21 .. '/' .. map }
    if map ~= 'nolevel' then -- saves made while the level wasn't detected
      dirs[#dirs + 1] = COURSES .. '/nolevel'
      dirs[#dirs + 1] = V21 .. '/nolevel'
    end
    return dirs
  end
  return {}
end

local function myDir() return COURSES .. '/' .. levelId() end

local function listCourses()
  local routes = {}
  for _, src in ipairs(SOURCES) do
    local seen = {}
    for _, dir in ipairs(sourceDirs(src)) do
      for _, f in ipairs(listFiles(dir, '%.json$')) do
        local name = f:match('^(.+)%.json$')
        if name and not name:find('%.wpt$') and not seen[name] then
          seen[name] = true
          routes[#routes + 1] = { name = name, source = src }
        end
      end
    end
  end
  return routes
end

-- returns dir, source (searches mine -> server -> legacy when source is nil)
local function findCourse(name, source)
  local order = source and { source } or SOURCES
  for _, src in ipairs(order) do
    for _, dir in ipairs(sourceDirs(src)) do
      if fileExists(coursePath(dir, name)) then return dir, src end
    end
  end
  return nil
end

local function readCourseFiles(dir, name)
  local data = readJson(coursePath(dir, name)) or {}
  local pts = data.pts or data -- v1 files are a bare array of {x,y}
  local wpts = readJson(wptPath(dir, name)) or {}
  return pts, wpts, data
end

local function saveCourseFiles(dir, name, pts, wpts, author) -- author: who recorded it (v3.1.7; kept on renames, copies, packs)
  local arr = {}
  for i, p in ipairs(pts) do
    local x, y = tonumber(p.x or p[1]), tonumber(p.y or p[2])
    if x and y then arr[#arr + 1] = { r2(x), r2(y), r2(tonumber(p.z or p[3]) or 0) } end
  end
  local length = 0
  for i = 2, #arr do length = length + sqrt((arr[i][1] - arr[i - 1][1]) ^ 2 + (arr[i][2] - arr[i - 1][2]) ^ 2) end
  local cp, wp = coursePath(dir, name), wptPath(dir, name)
  local okC = writeJson(cp, {
    format = 'TreadXLGPS-2', name = name, map = levelId(), created = os.time(), length = r2(length), pts = arr,
    author = (type(author) == 'string' and author ~= '') and author or nil,
  }, false)
  local okW = writeJson(wp, wptsForFile(wpts), true)
  -- trust the disk, not the call: the file has to be there afterwards
  local saved = okC and okW and fileExists(cp) and fileExists(wp)
  log_(saved and 'I' or 'E', (saved and 'saved ' or 'could not save ') .. cp .. ' (' .. #arr .. ' points, ' .. #wpts .. ' waypoints)')
  return saved, cp
end

local function uniqueName(base, dir)
  dir = dir or myDir()
  if not fileExists(coursePath(dir, base)) then return base end
  for n = 2, 999 do
    local cand = base .. '_' .. n
    if not fileExists(coursePath(dir, cand)) then return cand end
  end
  return base .. '_' .. tostring(os.time())
end

-- ------------------------------------------------------------------ GPX
local function gpxOrigin(map)
  local o = GPX_ORIGINS[map] or GPX_DEFAULT_ORIGIN
  return o[1], o[2]
end
local M_PER_DEG = 111320
local function toLatLon(x, y, lat0, lon0)
  return lat0 + y / M_PER_DEG, lon0 + x / (M_PER_DEG * math.cos(math.rad(lat0)))
end
local function fromLatLon(lat, lon, lat0, lon0)
  return (lon - lon0) * M_PER_DEG * math.cos(math.rad(lat0)), (lat - lat0) * M_PER_DEG
end

local function xmlEsc(s)
  return (tostring(s or ''):gsub('&', '&amp;'):gsub('<', '&lt;'):gsub('>', '&gt;'):gsub('"', '&quot;'))
end
local function xmlUnesc(s)
  s = tostring(s or '')
  s = s:gsub('&lt;', '<'):gsub('&gt;', '>'):gsub('&quot;', '"'):gsub('&apos;', "'")
  s = s:gsub('&#(%d+);', function(n) n = tonumber(n); return (n and n < 128) and string.char(n) or '' end)
  return (s:gsub('&amp;', '&'))
end

local GPX_SYM = { pacenote = 'Pacenote', vcp = 'Flag, Blue', zone = 'Speed Zone', zoneEnd = 'Speed Zone End', start = 'Flag, Green', pit = 'Car Repair',
  stop = 'Stop Sign', medic = 'Medical Facility', hazard = 'Danger Area', danger = 'Skull and Crossbones', note = 'Information' }

local function buildGpx(name, pts, wpts, map)
  local lat0, lon0 = gpxOrigin(map)
  local out = {
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Baja75 Navigation Unit" xmlns="http://www.topografix.com/GPX/1/1" xmlns:txl="https://baja75series.local/treadxl/1">',
    '  <metadata>',
    '    <name>' .. xmlEsc(name) .. '</name>',
    '    <desc>BeamNG.drive course on map ' .. xmlEsc(map) .. ' (Baja75 Navigation Unit)</desc>',
    string.format('    <extensions><txl:map>%s</txl:map><txl:origin lat="%.7f" lon="%.7f"/></extensions>', xmlEsc(map), lat0, lon0),
    '  </metadata>',
  }
  for _, w in ipairs(wpts) do
    local lat, lon = toLatLon(w.x, w.y, lat0, lon0)
    local kind = kindOf(w.icon)
    local ext = ''
    if w.limitMph then ext = ext .. '<txl:limitMph>' .. tostring(w.limitMph) .. '</txl:limitMph>' end
    if w.radius then ext = ext .. '<txl:radius>' .. tostring(w.radius) .. '</txl:radius>' end
    if w.s then ext = ext .. '<txl:s>' .. tostring(r2(w.s)) .. '</txl:s>' end
    if w.pn and PN then ext = ext .. '<txl:pn>' .. xmlEsc(PN.encode(w.pn)) .. '</txl:pn>' .. (w.auto and '<txl:auto>1</txl:auto>' or '') end
    out[#out + 1] = string.format('  <wpt lat="%.7f" lon="%.7f"><ele>%.2f</ele><name>%s</name><sym>%s</sym><type>%s</type>%s</wpt>',
      lat, lon, tonumber(w.z) or 0, xmlEsc(w.name or w.label or 'Waypoint'), xmlEsc(GPX_SYM[kind] or 'Waypoint'), xmlEsc(w.icon),
      ext ~= '' and ('<extensions>' .. ext .. '</extensions>') or '')
  end
  out[#out + 1] = '  <trk><name>' .. xmlEsc(name) .. '</name><trkseg>'
  for _, p in ipairs(pts) do
    local x, y = tonumber(p.x or p[1]), tonumber(p.y or p[2])
    if x and y then
      local lat, lon = toLatLon(x, y, lat0, lon0)
      out[#out + 1] = string.format('    <trkpt lat="%.7f" lon="%.7f"><ele>%.2f</ele></trkpt>', lat, lon, tonumber(p.z or p[3]) or 0)
    end
  end
  out[#out + 1] = '  </trkseg></trk>'
  out[#out + 1] = '</gpx>'
  return table.concat(out, '\n') .. '\n'
end

-- every <tag ...>body</tag> or <tag .../> in document order
local function xmlElements(text, tag)
  local out, pos, open = {}, 1, '<' .. tag
  while true do
    local s = text:find(open, pos, true)
    if not s then break end
    local c = text:sub(s + #open, s + #open)
    if c == '' or not c:match('[%s/>]') then
      pos = s + #open
    else
      local gt = text:find('>', s, true)
      if not gt then break end
      local attrs = text:sub(s + #open, gt - 1)
      if attrs:sub(-1) == '/' then
        out[#out + 1] = { attrs = attrs:sub(1, -2), body = '' }
        pos = gt + 1
      else
        local close = text:find('</' .. tag .. '>', gt, true)
        out[#out + 1] = { attrs = attrs, body = close and text:sub(gt + 1, close - 1) or '' }
        pos = (close or gt) + 1
      end
    end
  end
  return out
end
local function xmlAttr(attrs, key)
  return attrs:match('%f[%w:]' .. key .. '%s*=%s*"([^"]*)"') or attrs:match('%f[%w:]' .. key .. "%s*=%s*'([^']*)'")
end
local function xmlChild(body, tag)
  local v = body:match('<' .. tag .. '[^>]*>(.-)</' .. tag .. '>')
  return v and xmlUnesc(trim(v:gsub('^<!%[CDATA%[(.-)%]%]>$', '%1'))) or nil
end

local function iconFromGpx(name, sym, typ)
  if typ and ICON_KIND[typ] then return typ end
  local t = ((name or '') .. ' ' .. (sym or '')):lower()
  if t:find('vcp') or t:find('checkpoint') or t:find('flag') then return 'Tread_XL_icon_checkpoint.svg' end
  if t:find('speed') and t:find('end') then return 'Tread_XL_icon_speedzone_end.svg' end
  if t:find('speed') or t:find('sz') then return 'Tread_XL_icon_speedzone.svg' end
  if t:find('pit') or t:find('repair') then return 'Tread_XL_icon_repair.svg' end
  if t:find('start') or t:find('finish') then return 'Tread_XL_icon_start_finish.svg' end
  if t:find('danger') or t:find('skull') then return 'Tread_XL_icon_death.svg' end
  if t:find('hazard') or t:find('caution') or t:find('warn') then return 'Tread_XL_icon_warning.svg' end
  if t:find('rock') then return 'Tread_XL_icon_rock.svg' end
  if t:find('medic') or t:find('medical') then return 'Tread_XL_icon_health.svg' end
  if t:find('stop') then return 'Tread_XL_icon_stop.svg' end
  if t:find('turn') and t:find('left') then return 'Tread_XL_icon_turn_left.svg' end
  if t:find('turn') and t:find('right') then return 'Tread_XL_icon_turn_right.svg' end
  return 'Tread_XL_icon_mystery.svg'
end

-- returns name, pts, wpts (nil on failure)
local function parseGpx(text, map)
  if type(text) ~= 'string' or not text:find('<gpx', 1, true) then return nil end
  local lat0, lon0 = gpxOrigin(map)
  local o = text:match('<txl:origin[^>]*>')
  if o then
    local la, lo = tonumber(xmlAttr(o, 'lat')), tonumber(xmlAttr(o, 'lon'))
    if la and lo then lat0, lon0 = la, lo end
  end
  local meta = xmlElements(text, 'metadata')[1]
  local name = meta and xmlChild(meta.body, 'name') or nil
  local pts = {}
  local list = xmlElements(text, 'trkpt')
  if #list == 0 then list = xmlElements(text, 'rtept') end
  for _, e in ipairs(list) do
    local lat, lon = tonumber(xmlAttr(e.attrs, 'lat')), tonumber(xmlAttr(e.attrs, 'lon'))
    if lat and lon then
      local x, y = fromLatLon(lat, lon, lat0, lon0)
      pts[#pts + 1] = { x = x, y = y, z = tonumber(xmlChild(e.body, 'ele')) or 0 }
    end
  end
  local wpts = {}
  for _, e in ipairs(xmlElements(text, 'wpt')) do
    local lat, lon = tonumber(xmlAttr(e.attrs, 'lat')), tonumber(xmlAttr(e.attrs, 'lon'))
    if lat and lon then
      local x, y = fromLatLon(lat, lon, lat0, lon0)
      local wname = xmlChild(e.body, 'name')
      local icon = iconFromGpx(wname, xmlChild(e.body, 'sym'), xmlChild(e.body, 'type'))
      wpts[#wpts + 1] = {
        x = x, y = y, z = tonumber(xmlChild(e.body, 'ele')) or 0, icon = icon,
        label = safeLabel(wname or ''), limitMph = tonumber(xmlChild(e.body, 'txl:limitMph')),
        radius = tonumber(xmlChild(e.body, 'txl:radius')), s = tonumber(xmlChild(e.body, 'txl:s')),
        pnCode = xmlChild(e.body, 'txl:pn'), auto = xmlChild(e.body, 'txl:auto') == '1' or nil,
      }
      if icon == PNK.ICON then wpts[#wpts].label = '' end -- a pacenote's name is its call
    end
  end
  if not name then
    local trk = xmlElements(text, 'trk')[1]
    name = trk and xmlChild(trk.body, 'name') or nil
  end
  return name, pts, wpts
end

local function listGpx()
  local out = {}
  local map = levelId()
  for _, f in ipairs(listFiles(GPXDIR .. '/' .. map, '%.[gG][pP][xX]$')) do out[#out + 1] = { file = map .. '/' .. f, name = f } end
  for _, f in ipairs(listFiles(GPXDIR, '%.[gG][pP][xX]$')) do out[#out + 1] = { file = f, name = f, anyMap = true } end
  return out
end

-- ------------------------------------------------------------------ base map (terrain + roads) for the GPS screen
-- Built here from the AI road graph (map.getMap(), the same network BeamNG's own map draws) plus the level's
-- terrain image, then sent to the UI once per level as compact arrays.
local baseMapCache = { level = nil, data = nil }

-- ------------------------------------------------------------------ course map picture (server pack / GPX export)
-- The GPS app draws the course at 1920 x 1080 (the base game's map or the terrain heightmap, roads, course line,
-- symbols, pacenote tiles and a title band) and sends it back as a JPEG in base64 chunks; written next to the export
-- as <name>.map.jpg with <name>.info.txt (course, map, distance, elevation change).
local Snap = { jobs = {}, seq = 0, TIMEOUT = 30, MAX = 16 * 1024 * 1024 }

-- width of a PNG from its header (for a heightmap with no TerrainBlock to place it by)
function Snap.pngWidth(p)
  local ok, w = pcall(function()
    local f = io.open(p, 'rb')
    if not f then return nil end
    local head = f:read(24)
    f:close()
    if type(head) ~= 'string' or #head < 24 or head:sub(2, 4) ~= 'PNG' then return nil end
    local a, b, c, d = head:byte(17, 20)
    return ((a * 256 + b) * 256 + c) * 256 + d
  end)
  return ok and tonumber(w) or nil
end

-- the level's terrain heightmap picture (theTerrain_smoothed_heightmap.png or similar, anywhere in the level folder),
-- placed over the TerrainBlock: the "satellite" background, and the GPS map's fallback when the level has no map image
function Snap.heightmapTile()
  if not FS then return nil end
  local files
  pcall(function() files = FS:findFiles('/levels/' .. levelKey() .. '/', '*heightmap*.png', -1, true, false) end)
  if type(files) ~= 'table' or #files == 0 then return nil end
  local list = {}
  for _, f in ipairs(files) do list[#list + 1] = tostring(f) end
  table.sort(list, function(a, b)
    local ra, rb = a:lower():find('smooth', 1, true) and 0 or 1, b:lower():find('smooth', 1, true) and 0 or 1
    if ra ~= rb then return ra < rb end
    return a < b
  end)
  local img, size, px, py = list[1], nil, nil, nil
  pcall(function()
    local t = getObjectByClass and getObjectByClass('TerrainBlock')
    if not t then
      local names = scenetree.findClassObjects('TerrainBlock')
      if names and #names > 0 then t = scenetree.findObject(names[1]) end
    end
    if t then
      size = tonumber(t:getWorldBlockSize())
      local pos = t:getPosition()
      px, py = tonumber(pos.x), tonumber(pos.y)
    end
  end)
  if not (size and size > 0 and px and py) then
    local w = Snap.pngWidth(img)
    if not w then return nil end
    size, px, py = w, -w / 2, -w / 2 -- 1 m per pixel, centred: the usual layout
  end
  return { image = img, x = px, y = py + size, w = size, h = size, height = true }
end

-- terrain image tiles: x = west edge, y = north edge, w/h in metres (level info minimap, else the TerrainBlock's map
-- image, else the terrain heightmap unless noHeight)
local function terrainTiles(noHeight)
  local tiles = {}
  local ok, info = pcall(function() return core_levels.getLevelByName(levelKey()) end)
  if ok and type(info) == 'table' and type(info.minimap) == 'table' then
    local list = info.minimap
    if list.file or list.image or list.path then list = { list } end
    for _, t in ipairs(list) do
      if type(t) == 'table' then
        local file, off, size = t.file or t.path or t.image, t.offset, t.size
        if type(file) == 'string' and type(off) == 'table' and type(size) == 'table' and tonumber(size[1]) and tonumber(size[2]) then
          tiles[#tiles + 1] = { image = file, x = tonumber(off[1]) or 0, y = tonumber(off[2]) or 0, w = tonumber(size[1]), h = tonumber(size[2]) }
        end
      end
    end
  end
  if #tiles == 0 then
    pcall(function()
      local t = getObjectByClass and getObjectByClass('TerrainBlock')
      if not t then
        local names = scenetree.findClassObjects('TerrainBlock')
        if names and #names > 0 then t = scenetree.findObject(names[1]) end
      end
      if t then
        local size, p, img = t:getWorldBlockSize(), t:getPosition(), tostring(t.minimapImage or '')
        if type(img) == 'string' and img ~= '' and tonumber(size) and p then
          tiles[1] = { image = img, x = p.x, y = p.y + size, w = size, h = size }
        end
      end
    end)
  end
  if #tiles == 0 and not noHeight then
    local h = Snap.heightmapTile()
    if h then tiles[1] = h end
  end
  return tiles
end

local function r1(v) return floor(v * 10 + 0.5) / 10 end

-- returns data or nil, reason
local function buildRoadNetwork()
  local ok, m = pcall(function() return map.getMap() end)
  if not ok or type(m) ~= 'table' or type(m.nodes) ~= 'table' then return nil, 'road graph not available yet' end
  local index, seen, pts, edges, n = {}, {}, {}, {}, 0
  for id, nd in pairs(m.nodes) do
    local p = type(nd) == 'table' and not nd.hiddenInNavi and nd.pos
    if p and tonumber(p.x) and tonumber(p.y) then
      n = n + 1
      index[id] = n - 1
      pts[#pts + 1] = r1(p.x); pts[#pts + 1] = r1(p.y); pts[#pts + 1] = r1(tonumber(nd.radius) or 2)
    end
  end
  for id, nd in pairs(m.nodes) do
    local a = index[id]
    if a and type(nd.links) == 'table' then
      for id2, l in pairs(nd.links) do
        local b = index[id2]
        local hidden = type(l) == 'table' and l.hiddenInNavi
        if b and a ~= b and not hidden then
          local lo, hi = math.min(a, b), math.max(a, b)
          local k = lo * 1048576 + hi
          if not seen[k] then -- dedupe a-b / b-a
            seen[k] = true
            local d = type(l) == 'table' and tonumber(l.drivability) or 1
            edges[#edges + 1] = lo; edges[#edges + 1] = hi; edges[#edges + 1] = floor((d or 1) * 100 + 0.5)
          end
        end
      end
    end
  end
  local tiles = terrainTiles()
  if n == 0 or #edges == 0 then
    -- no roads (yet): still show the terrain image if there is one, and keep asking for the roads
    if #tiles > 0 then return { pts = {}, edges = {}, tiles = tiles, level = levelId(), nodes = 0, roads = 0, source = 'terrain' }, 'no roads yet' end
    return nil, 'road graph is empty (level still loading?)'
  end
  return { pts = pts, edges = edges, tiles = tiles, level = levelId(), nodes = n, roads = #edges / 3, source = 'roadgraph' }
end

local function sendBaseMap(force)
  if not inLevel() then trigger('basemap', { pending = true, reason = 'waiting for a level to load' }); return end
  local key = levelId()
  if force or not baseMapCache.data or baseMapCache.level ~= key then
    local net, why = buildRoadNetwork()
    if not net then trigger('basemap', { pending = true, reason = why, level = key }); return end
    if net.source ~= 'roadgraph' then trigger('basemap', net); return end -- terrain only: don't cache, roads may follow
    baseMapCache = { level = key, data = net }
  end
  trigger('basemap', baseMapCache.data)
end

-- ------------------------------------------------------------------ UI pushes
local function sendList()
  local map = levelId()
  trigger('list', {
    map = map, routes = listCourses(), gpx = listGpx(),
    -- the Common Edition: how many of its 2 courses are used
    common = (M._lock and M._lock.limited()) and { used = M._lock.courseCount(), max = M._lock.maxCourses(), free = PNK.EDITION == 'free' or nil, onyx = PNK.EDITION == 'onyx' or nil } or nil,
    loaded = course and { name = course.name, source = course.source } or nil,
    paths = {
      user = looksLikePath(userFolder()) and userFolder() or nil,
      courses = COURSES:sub(2) .. '/' .. map, gpx = GPXDIR:sub(2) .. '/' .. map, pack = PACK:sub(2),
    },
    -- the same folders as they are on this player's disk
    real = { courses = realPath(COURSES .. '/' .. map), gpx = realPath(GPXDIR .. '/' .. map), pack = realPath(PACK) },
  })
end

local function sendCourse()
  if not course then trigger('course', { name = nil }); return end
  trigger('course', {
    name = course.name, source = course.source, readOnly = (course.source == 'server' or course.source == 'rally') or nil,
    length = r2(course.length), flat = flatPts(course.pts),
    wpts = wptsForUi(course.sorted),
    zones = course.zones,
  })
end

local function sendWpts()
  if rec then
    trigger('wpts', { owner = 'rec', wpts = wptsForUi(rec.wpts) })
  elseif course then
    trigger('wpts', { owner = 'course', wpts = wptsForUi(course.sorted) })
  else
    trigger('wpts', { owner = nil, wpts = {} })
  end
end

local function sendTrail(full)
  if not rec then trigger('trail', { reset = true, flat = {} }); return end
  local from = full and 1 or (rec.sentIdx + 1)
  local flat = {}
  for i = from, #rec.pts do
    flat[#flat + 1] = r2(rec.pts[i].x)
    flat[#flat + 1] = r2(rec.pts[i].y)
  end
  rec.sentIdx = #rec.pts
  trigger('trail', { reset = full or nil, flat = flat })
end

local function sendRec()
  trigger('rec', { active = rec ~= nil, name = rec and rec.name or nil })
end

-- ------------------------------------------------------------------ course loading
local PNC = {}                -- pacenote call helpers (one table: the main chunk is near Lua's 200-locals limit)

function PNC.pnClearNative()
  if next(pnRun.shown) ~= nil and guihooks and guihooks.trigger then pcall(guihooks.trigger, 'clearAllVisualPacenotes') end
  pnRun.shown = {}
end

function PNC.pnReset()
  pnRun.idx, pnRun.lastS = 1, nil
  if PN then PN.clear() end
  PNC.pnClearNative()
end

local function resetRun()
  PNC.pnReset()
  vcpState = {}
  runStartS = nil
  finished = false
  transient = {}
  track = {}
  progress = nil
end

local function loadCourse(name, source)
  name = safeName(name)
  if name == '' then return false end
  if source ~= 'mine' and source ~= 'server' and source ~= 'rally' and source ~= 'legacy' then source = nil end
  local dir, src = findCourse(name, source)
  if not dir then toast('Course not found: ' .. name, 'warning'); sendList(); return false end
  local pts, wpts = readCourseFiles(dir, name)
  course = buildCourse(name, pts, wpts)
  course.dir, course.source = dir, src
  resetRun()
  sendCourse()
  sendList()
  if not course.hasLine and #course.wpts == 0 then toast('Course "' .. name .. '" is empty', 'warning') end
  return true
end

local function unloadCourse()
  course = nil
  resetRun()
  sendCourse()
  sendList()
  if not rec then sendWpts() end
end

local function saveLoadedCourseWpts()
  if not course or course.source == 'server' or course.source == 'rally' then return end
  writeJson(wptPath(course.dir or myDir(), course.name), wptsForFile(course.wpts), true)
end

-- ------------------------------------------------------------------ recording
local function addRecPoint(x, y, z, force)
  local n = #rec.pts
  local last = rec.pts[n]
  if last then
    local d = sqrt((x - last.x) ^ 2 + (y - last.y) ^ 2)
    if d < (force and 0.5 or REC_STEP) then return end
    rec.dist = rec.dist + d -- same polyline length the saved course will have
  end
  rec.pts[n + 1] = { x = x, y = y, z = z or 0 }
end

local function startRecording(name)
  if rec then M.stopRecording() end
  local base = safeName(name)
  if base == '' then base = os.date('route_%Y%m%d_%H%M%S') end
  rec = { name = uniqueName(base), pts = {}, wpts = {}, dist = 0, sentIdx = 0 }
  if me then addRecPoint(me.x, me.y, me.z, true) end
  sendRec()
  sendTrail(true)
  sendWpts()
  toast('Recording "' .. rec.name .. '"', 'info')
end

local function stopRecording(discard)
  if not rec then return end
  local r = rec
  if me then addRecPoint(me.x, me.y, me.z, true) end
  rec = nil
  sendRec()
  sendTrail(true)
  if discard == true then
    toast('Recording discarded', 'info')
    sendWpts()
    return
  end
  if #r.pts < 2 then
    toast('Recording too short - nothing saved', 'warning')
    sendWpts()
    return
  end
  local saved, path = saveCourseFiles(myDir(), r.name, r.pts, r.wpts, M._who and M._who() or nil)
  if saved then
    toast('Saved "' .. r.name .. '" to ' .. path:sub(2), 'success')
    loadCourse(r.name, 'mine')
  else
    toast('Could not write ' .. tostring(path):sub(2) .. ' - check the console (~) for details', 'error')
  end
  sendWpts()
end

-- ------------------------------------------------------------------ waypoints
local function markWaypoint(opts)
  opts = type(opts) == 'table' and opts or {}
  local x, y = tonumber(opts.x), tonumber(opts.y)
  local atVehicle = not (x and y)
  if atVehicle then
    if not me then toast('No vehicle to mark from', 'warning'); return end
    x, y = me.x, me.y
  end
  local icon = safeIcon(opts.icon or markDefaults.icon)
  if not PNK.shows(kindOf(icon)) then toast('The Chase Edition marks pits, start / finish, VCPs and speed zones only', 'warning'); return end
  if PNK.EDITION == 'onyx' and not PNK.ONYX_KINDS[kindOf(icon)] then toast('The Onyx Edition marks hazards, danger, medic, turns and notes', 'warning'); return end
  local w = {
    x = x, y = y, z = atVehicle and me and me.z or 0, icon = icon,
    label = safeLabel(opts.label or ''), limitMph = tonumber(opts.limitMph) or markDefaults.limitMph,
  }
  if kindOf(icon) ~= 'zone' then w.limitMph = nil end
  if kindOf(icon) == 'pacenote' then
    w.pn = PN and PN.normalize(opts.pn or markDefaults.pn) or nil
    if not w.pn then toast('Build a pacenote first (MARK > Rally)', 'warning'); return end
    w.label = ''
  end
  if rec then
    if atVehicle then
      local last = rec.pts[#rec.pts]
      w.s = rec.dist + (last and sqrt((x - last.x) ^ 2 + (y - last.y) ^ 2) or 0)
    end
    local nw = normalizeWpt(w, #rec.wpts + 1)
    nw.name = nw.label or nil
    rec.wpts[#rec.wpts + 1] = nw
    -- keep the label default consistent with how the saved course will name it
    local tmp = buildCourse('tmp', {}, rec.wpts)
    for i, tw in ipairs(tmp.wpts) do rec.wpts[i].name = tw.name end
    sendWpts()
    toast('Marked ' .. (rec.wpts[#rec.wpts].name or 'waypoint'), 'success')
    return
  end
  if course then
    if course.source == 'server' or course.source == 'rally' then
      toast((course.source == 'rally' and 'Rally Courses' or 'Server courses') .. ' are read-only - MENU > Courses > Save a copy, then mark', 'warning')
      return
    end
    if atVehicle and progress and progress.off <= OFF_COURSE then w.s = progress.s end
    local raw = wptsForFile(course.wpts)
    raw[#raw + 1] = { x = r2(w.x), y = r2(w.y), z = r2(w.z), icon = w.icon, label = w.label, limitMph = w.limitMph, s = w.s, pn = w.pn }
    local dir, name, src = course.dir, course.name, course.source
    course = buildCourse(name, course.pts, raw)
    course.dir, course.source = dir, src -- vcpState is keyed by file position, which appending doesn't change
    saveLoadedCourseWpts()
    sendCourse()
    local added = course.wpts[#course.wpts]
    toast('Marked ' .. ((added and added.name) or 'waypoint'), 'success')
    return
  end
  toast('Start recording or load a course to mark waypoints', 'warning')
end

local function deleteWaypoint(id)
  id = tonumber(id)
  if not id then return end
  if rec then
    if rec.wpts[id] then table.remove(rec.wpts, id) end
    for i, w in ipairs(rec.wpts) do w.id = i end
    local tmp = buildCourse('tmp', {}, rec.wpts)
    for i, tw in ipairs(tmp.wpts) do rec.wpts[i].name = tw.name end
    sendWpts()
    return
  end
  if course and (course.source == 'server' or course.source == 'rally') then
    toast('This course is read-only', 'warning')
    return
  end
  if course and course.wpts[id] then
    local raw = wptsForFile(course.wpts)
    table.remove(raw, id)
    local dir, name, src = course.dir, course.name, course.source
    course = buildCourse(name, course.pts, raw)
    course.dir, course.source = dir, src
    vcpState = {}
    saveLoadedCourseWpts()
    sendCourse()
  end
end

-- ------------------------------------------------------------------ chase
local function isMine(id, playerId)
  if id == playerId then return true end
  if MPVehicleGE and MPVehicleGE.isOwn then
    local ok, r = pcall(MPVehicleGE.isOwn, id)
    if ok and r then return true end
  end
  return false
end

local function vehicleInfo(id, veh)
  local name, model
  if MPVehicleGE and MPVehicleGE.getVehicleByGameID then
    local ok, mv = pcall(MPVehicleGE.getVehicleByGameID, id)
    if ok and type(mv) == 'table' then
      name = mv.ownerName
      model = mv.jbeam
    end
  end
  if not model then
    local ok, j = pcall(function() return veh:getJBeamFilename() end)
    if ok then model = j end
  end
  if not name or name == '' then name = (model or 'Vehicle') .. ' #' .. tostring(id) end
  return name, model
end

local function chaseCandidates()
  local list = {}
  local playerId = -1
  local pv = playerVehicle()
  if pv then
    local ok, id = pcall(function() return pv:getID() end)
    if ok then playerId = id end
  end
  local okAll, all = pcall(function() return getAllVehicles and getAllVehicles() or {} end)
  if not okAll or type(all) ~= 'table' then return list end
  for _, v in ipairs(all) do
    local okId, id = pcall(function() return v:getID() end)
    if okId and id and not isMine(id, playerId) then
      local name, model = vehicleInfo(id, v)
      if not PROP_JBEAMS[model or ''] then
        local s = sampleVehicle(v)
        local d = (s and me) and sqrt((s.x - me.x) ^ 2 + (s.y - me.y) ^ 2) or nil
        list[#list + 1] = { id = id, name = name, model = model, dist = d and r2(d) or nil }
      end
    end
  end
  table.sort(list, function(a, b) return (a.dist or 1e12) < (b.dist or 1e12) end)
  return list
end

local function sendChaseTargets()
  trigger('chaseTargets', { targets = chaseCandidates(), current = chase.id, interval = chase.interval })
end

local function setChaseTarget(id)
  id = tonumber(id)
  chase.snap, chase.snapT, chase.track = nil, -1e9, {}
  if not id or id < 0 then
    chase.id, chase.name = nil, nil
    sendChaseTargets()
    return
  end
  local v = getVehicleById(id)
  if not v then toast('That vehicle is gone', 'warning'); sendChaseTargets(); return end
  chase.id = id
  chase.name = (vehicleInfo(id, v))
  toast('Chasing ' .. chase.name, 'info')
  sendChaseTargets()
end

local function chaseNext()
  local list = chaseCandidates()
  if #list == 0 then toast('No vehicles to chase', 'warning'); return end
  local idx = 0
  for i, t in ipairs(list) do if t.id == chase.id then idx = i end end
  if idx >= #list then setChaseTarget(-1) else setChaseTarget(list[idx + 1].id) end
end

local function updateChase()
  if not chase.id then return nil end
  local v = getVehicleById(chase.id)
  if not v then
    return { id = chase.id, name = chase.name, lost = true }
  end
  if chase.interval <= 0 or not chase.snap or clock - chase.snapT >= chase.interval then
    local s = sampleVehicle(v, chase.snap and chase.snap.heading)
    if s then chase.snap, chase.snapT = s, clock end
  end
  local s = chase.snap
  if not s then return { id = chase.id, name = chase.name, lost = true } end
  local out = {
    id = chase.id, name = chase.name, x = r2(s.x), y = r2(s.y), heading = floor(s.heading + 0.5),
    speed = r2(s.speed), age = chase.interval > 0 and floor(clock - chase.snapT) or 0, interval = chase.interval,
  }
  if me then
    out.dist = r2(sqrt((s.x - me.x) ^ 2 + (s.y - me.y) ^ 2))
    out.bearing = floor(bearing(me.x, me.y, s.x, s.y) + 0.5)
  end
  if course and course.hasLine then
    local off, cs = project(course, chase.track, s.x, s.y)
    if off and off <= OFF_COURSE * 2 then
      out.s = r2(cs)
      if progress and progress.off <= OFF_COURSE * 2 then out.gap = r2(cs - progress.s) end
    end
  end
  return out
end

-- ------------------------------------------------------------------ other vehicles on the map
-- every vehicle near you (BeamMP players by name, AI / parked cars by model), like BeamNG's own map shows them
local OTHERS_RANGE, OTHERS_MAX, OTHERS_EVERY = 3000, 40, 0.2
local othersCache, othersT, nameCache = nil, -1e9, {}

local function cachedInfo(id, veh)
  local c = nameCache[id]
  if not c or clock - c.t > 5 then
    local name, model = vehicleInfo(id, veh)
    local mp = false
    if MPVehicleGE and MPVehicleGE.getVehicleByGameID then
      local ok, mv = pcall(MPVehicleGE.getVehicleByGameID, id)
      mp = ok and type(mv) == 'table' and mv.ownerName ~= nil
    end
    c = { name = name, model = model, mp = mp, t = clock }
    nameCache[id] = c
  end
  return c
end

local function nearbyVehicles()
  if not me then return nil end
  if othersCache and clock - othersT < OTHERS_EVERY then return othersCache end
  local list = {}
  local playerId = -1
  local pv = playerVehicle()
  if pv then
    local ok, id = pcall(function() return pv:getID() end)
    if ok then playerId = id end
  end
  local okAll, all = pcall(function() return getAllVehicles and getAllVehicles() or {} end)
  if okAll and type(all) == 'table' then
    for _, v in ipairs(all) do
      local okId, id = pcall(function() return v:getID() end)
      if okId and id and id ~= chase.id and not isMine(id, playerId) then
        local okA, active = pcall(function() return v:getActive() end)
        if not okA or active ~= false then
          local info = cachedInfo(id, v)
          if not PROP_JBEAMS[info.model or ''] then
            local sv = sampleVehicle(v)
            if sv then
              local d = sqrt((sv.x - me.x) ^ 2 + (sv.y - me.y) ^ 2)
              if d <= OTHERS_RANGE then
                list[#list + 1] = { id = id, x = r2(sv.x), y = r2(sv.y), h = floor(sv.heading + 0.5), name = info.name, mp = info.mp or nil, d = d }
              end
            end
          end
        end
      end
    end
  end
  table.sort(list, function(a, b) return a.d < b.d end)
  for i = #list, OTHERS_MAX + 1, -1 do list[i] = nil end
  for _, o in ipairs(list) do o.d = nil end
  othersCache, othersT = list, clock
  return list
end

-- ------------------------------------------------------------------ per-tick course logic
local function pushTransient(alert, seconds)
  transient[#transient + 1] = { alert = alert, untilT = clock + (seconds or 4) }
end

local function nextWaypoints(n)
  local out = {}
  if not course then return out end
  if course.hasLine and progress then
    local s = progress.s
    for _, w in ipairs(course.sorted) do
      if w.s and w.s > s + 2 and w.kind ~= 'pacenote' then
        out[#out + 1] = {
          id = w.id, label = w.name, icon = w.icon, kind = w.kind, ahead = r2(w.s - s), s = r2(w.s),
          limitMph = w.limitMph, status = vcpState[w.id],
        }
        if #out >= n then break end
      end
    end
  elseif me then
    -- waypoints without a course line: nearest first, straight-line distance
    local tmp = {}
    for _, w in ipairs(course.sorted) do
      if w.kind ~= 'pacenote' then tmp[#tmp + 1] = { w = w, d = sqrt((w.x - me.x) ^ 2 + (w.y - me.y) ^ 2) } end
    end
    table.sort(tmp, function(a, b) return a.d < b.d end)
    for i = 1, math.min(n, #tmp) do
      local w = tmp[i].w
      out[#out + 1] = { id = w.id, label = w.name, icon = w.icon, kind = w.kind, ahead = r2(tmp[i].d), limitMph = w.limitMph, status = vcpState[w.id] }
    end
  end
  return out
end

local function updateCourse()
  if not (course and me) then progress = nil; return nil end
  local alerts = {}
  local zone = nil
  if course.hasLine then
    local off, s, i = project(course, track, me.x, me.y)
    progress = { off = off, s = s, i = i }
    if off <= OFF_COURSE and not runStartS then runStartS = s - 5 end

    -- VCPs: cleared inside the radius, missed once you're clearly past it on course
    for _, w in ipairs(course.sorted) do
      if w.kind == 'vcp' and not vcpState[w.id] and PNK.EDITION ~= 'onyx' then -- (Onyx: waypoints are only map aids)
        local d = sqrt((w.x - me.x) ^ 2 + (w.y - me.y) ^ 2)
        if d <= (w.radius or VCP_RADIUS) then
          vcpState[w.id] = 'cleared'
          pushTransient({ kind = 'vcpCleared', level = 'ok', label = w.name }, 4)
          if race and race.state == 'running' and race.t0 then
            race.splits[#race.splits + 1] = { label = w.name, t = r2(raceClock - race.t0) }
            playSfx('event:UI_Checkpoint')
          end
        elseif runStartS and w.s and w.s > runStartS and off <= OFF_COURSE
          and s > w.s + math.max(w.radius or VCP_RADIUS, 50) and s - w.s < 2000 then
          vcpState[w.id] = 'missed'
          pushTransient({ kind = 'vcpMissed', level = 'danger', label = w.name }, 6)
        end
      end
    end

    -- speed zones
    local mph = me.speed * MPS_TO_MPH
    for _, z in ipairs(course.zones) do
      if s >= z.s0 and s <= z.s1 and off <= OFF_COURSE then
        zone = { limitMph = z.limitMph, overMph = r2(math.max(0, mph - z.limitMph)), label = z.label }
        break
      end
    end
    if zone and zone.overMph > 1 then
      alerts[#alerts + 1] = { kind = 'overspeed', level = 'danger', limitMph = zone.limitMph, overMph = zone.overMph }
    end

    -- OFF COURSE from 15 m (set in Display); clears once you're back within 80 % of that
    offCourseShown = off > offCourseAlert or (offCourseShown and off > offCourseAlert * 0.8)
    if offCourseShown then
      alerts[#alerts + 1] = { kind = 'offCourse', level = 'warn', meters = floor(off + 0.5) }
    else
      -- wrong way: driving against the course direction
      local seg = course.pts[i + 1] and { course.pts[i], course.pts[i + 1] }
      if seg and me.speed > 4 and me.dx then
        local ex, ey = seg[2].x - seg[1].x, seg[2].y - seg[1].y
        local L = sqrt(ex * ex + ey * ey)
        if L > 0 and (me.dx * ex + me.dy * ey) / L < -0.6 then
          alerts[#alerts + 1] = { kind = 'wrongWay', level = 'warn' }
        end
      end
    end

    if not finished and course.length > 50 and course.length - s < 25 and off <= OFF_COURSE and runStartS and s - runStartS > 100 then
      finished = true
      pushTransient({ kind = 'finish', level = 'ok' }, 8)
    end

    if not zone then
      for _, z in ipairs(course.zones) do
        local ahead = z.s0 - s
        if ahead > 0 and ahead <= AHEAD_ALERT then
          alerts[#alerts + 1] = { kind = 'zoneAhead', level = 'info', limitMph = z.limitMph, meters = floor(ahead + 0.5) }
          break
        end
      end
    end
    for _, w in ipairs(course.sorted) do
      if w.kind == 'vcp' and not vcpState[w.id] and w.s and w.s > s then
        local ahead = w.s - s
        if ahead <= AHEAD_ALERT then
          alerts[#alerts + 1] = { kind = 'vcpAhead', level = 'info', label = w.name, meters = floor(ahead + 0.5) }
        end
        break
      end
    end
    -- danger and hazard markers: from 400 m ahead until just past them (the alert displays flash 3 times)
    for _, w in ipairs(course.sorted) do
      if (w.kind == 'danger' or w.kind == 'hazard') and w.s and w.s > s - 5 then
        if w.s - s <= AHEAD_ALERT then
          alerts[#alerts + 1] = { kind = w.kind .. 'Ahead', level = 'warn', label = w.name, icon = w.icon, id = w.id,
            meters = floor(math.max(0, w.s - s) + 0.5) }
        end
        break
      end
    end
  else
    progress = nil
    for _, w in ipairs(course.sorted) do
      if w.kind == 'vcp' and not vcpState[w.id] and PNK.EDITION ~= 'onyx' then -- (Onyx: waypoints are only map aids)
        local d = sqrt((w.x - me.x) ^ 2 + (w.y - me.y) ^ 2)
        if d <= (w.radius or VCP_RADIUS) then
          vcpState[w.id] = 'cleared'
          pushTransient({ kind = 'vcpCleared', level = 'ok', label = w.name }, 4)
        end
      end
    end
  end
  return alerts, zone
end

local LEVEL_RANK = { danger = 4, warn = 3, ok = 2, info = 1 }

local function pickAlert(alerts)
  -- live alerts that matter most (overspeed, off course, wrong way) beat transients; transients beat info
  local best = nil
  local function consider(a)
    if not best then best = a; return end
    local ra, rb = LEVEL_RANK[a.level] or 0, LEVEL_RANK[best.level] or 0
    if ra > rb then best = a
    elseif ra == rb and a.meters and best.meters and a.meters < best.meters then best = a end -- nearer warning first
  end
  local keep = {}
  for _, t in ipairs(transient) do
    if t.untilT > clock then keep[#keep + 1] = t; consider(t.alert) end
  end
  transient = keep
  for _, a in ipairs(alerts or {}) do consider(a) end
  return best
end

-- the next waypoint of one kind: along the course line, or the nearest one when the course has no line
local function nextOfKind(kind, skipDone)
  if not course then return nil end
  if course.hasLine and progress then
    for _, w in ipairs(course.sorted) do
      if w.kind == kind and w.s and w.s > progress.s + 2 and not (skipDone and vcpState[w.id]) then
        return { label = w.name, ahead = r2(w.s - progress.s) }
      end
    end
    return nil
  end
  if not me then return nil end
  local best = nil
  for _, w in ipairs(course.sorted) do
    if w.kind == kind and not (skipDone and vcpState[w.id]) then
      local d = sqrt((w.x - me.x) ^ 2 + (w.y - me.y) ^ 2)
      if not best or d < best.ahead then best = { label = w.name, ahead = r2(d), straight = true } end
    end
  end
  return best
end

local function vcpCounts()
  local cleared, missed, total = 0, 0, 0
  if course then
    for _, w in ipairs(course.wpts) do
      if w.kind == 'vcp' then
        total = total + 1
        if vcpState[w.id] == 'cleared' then cleared = cleared + 1 elseif vcpState[w.id] == 'missed' then missed = missed + 1 end
      end
    end
  end
  return cleared, missed, total
end

-- ------------------------------------------------------------------ race timing
local function raceStartPoint()
  if not course or not course.hasLine then return nil end
  return course.pts[1].x, course.pts[1].y
end

local function raceDistToStart()
  local sx, sy = raceStartPoint()
  if not sx or not me then return nil end
  return sqrt((me.x - sx) ^ 2 + (me.y - sy) ^ 2)
end

local function timesPath(name) return TIMES .. '/' .. levelId() .. '/' .. name .. '.json' end

local function readTimes(name)
  local t = readJson(timesPath(name)) or {}
  if type(t.runs) ~= 'table' then t.runs = {} end
  t.best = tonumber(t.best)
  return t
end

local raceStartCountdown
local function raceRoute(name, source, startNow)
  if not loadCourse(name, source) then return end
  if not course.hasLine then race = nil; toast('This course has no course line to race', 'warning'); return end
  race = { state = 'staging', name = course.name, source = course.source, best = readTimes(course.name).best, jumps = 0 }
  if startNow and me then
    local p = course.pts[1]
    if sqrt((me.x - p.x) ^ 2 + (me.y - p.y) ^ 2) <= RACE_START_RADIUS then raceStartCountdown(); return end
  end
  toast('Race loaded - drive to the starting line (or tap TO START to be moved there)', 'info')
end

-- put the player's vehicle on the starting line, facing down the course (practice, or a long drive to the start)
local function raceTeleportToStart()
  if not race or race.state == 'countdown' or race.state == 'running' then return end
  if not course or not course.hasLine then return end
  local p1, p2 = course.pts[1], course.pts[#course.pts]
  for i = 2, #course.pts do
    if course.cum[i] >= 8 then p2 = course.pts[i]; break end
  end
  local veh = playerVehicle()
  if not veh then toast('No vehicle to move', 'warning'); return end
  local ok, err = pcall(function()
    local dx, dy = p2.x - p1.x, p2.y - p1.y
    local L = sqrt(dx * dx + dy * dy)
    if L < 0.01 then dx, dy, L = 0, 1, 1 end
    local z = (p1.z and p1.z ~= 0) and p1.z or (me and me.z) or 0
    spawn.safeTeleport(veh, vec3(p1.x, p1.y, z + 0.5), quatFromDir(vec3(dx / L, dy / L, 0), vec3(0, 0, 1)), nil, nil, false, true)
  end)
  if ok then
    race.state, race.result = 'staging', nil
    race.quietUntil = clock + 2 -- the game may report this move as a vehicle reset: not one of yours
    toast('On the starting line - press START RACE', 'info')
  else
    log_('E', 'teleport to start failed: ' .. tostring(err))
    toast('Could not move the vehicle - drive to the start', 'warning')
  end
end

-- countdown / GO / false start: the co-driver's voice when pacenote calls are on, the game's beeps otherwise
local function raceCall(key, beep)
  if PN and not PN.voice() then PN.setVoice(pnOpts.voice) end
  if soundOn and PN and pnOpts.calls ~= 'off' and PN.voice() and PN.system(key) then return end
  playSfx(beep)
end

raceStartCountdown = function()
  if not race or (race.state ~= 'staging' and race.state ~= 'finished') then return end
  local d = raceDistToStart()
  if not d or d > RACE_START_RADIUS then
    toast('Get within ' .. RACE_START_RADIUS .. ' m of the starting line first', 'warning')
    return
  end
  race.state, race.cdEnd, race.lastBeep, race.result = 'countdown', raceClock + RACE_COUNTDOWN, nil, nil
  if PN and not PN.voice() then PN.setVoice(pnOpts.voice) end
  if soundOn and PN and pnOpts.calls ~= 'off' and PN.voice() then PN.clear(); PN.system('precountdown') end
end

-- ------------------------------------------------------------------ damage log (optional: Display > Damage log)
-- During a timed run: when the car takes a hit (the game's damage energy jumps), ask the vehicle which parts are
-- damaged (beamstate.getPartDamageData, plus flat tyres and engine faults) and log the ones that got worse.
-- Self-contained: this block, Dmg.tick() in tick(), Dmg.start() in raceGo() and the Dmg lines in RunLog / the hooks.
local Dmg = {
  on = true,
  STEP = 1000,      -- J of new damage energy that counts as a hit (the game's traffic uses the same "low damage" mark)
  SETTLE = 0.6,     -- s after the hit before asking, so the whole crash is in
  MIN_RISE = 5,     -- % a part has to get worse by to be listed
  MAX_PARTS = 6,    -- parts named per hit (worst first)
  base = {}, last = nil, pending = nil, rebaseAt = nil,
}
-- runs in the vehicle's Lua; answers TreadXLGPS.onPartDamage({ { k = id, n = name, d = % | f = 1 }, ... }, tag)
Dmg.VLUA = [==[
local out = {}
pcall(function()
  for k, p in pairs(beamstate.getPartDamageData() or {}) do
    if type(p) == 'table' and (tonumber(p.damage) or 0) > 0.01 then out[#out + 1] = { k = tostring(k), n = tostring(p.name or k), d = math.floor(p.damage * 100 + 0.5) } end
  end
end)
pcall(function()
  for _, wd in pairs(wheels.wheels or {}) do
    if type(wd) == 'table' and wd.name and (wd.isTireDeflated or damageTracker.getDamage('wheels', 'tire' .. wd.name)) then out[#out + 1] = { k = 'tire' .. wd.name, n = 'Flat tire ' .. wd.name, f = 1 } end
  end
end)
pcall(function()
  for _, e in ipairs({ { 'engineDisabled', 'Engine disabled' }, { 'engineLockedUp', 'Engine locked up' }, { 'engineHydrolocked', 'Engine hydrolocked' },
    { 'radiatorLeak', 'Radiator leak' }, { 'oilpanLeak', 'Oil pan leak' }, { 'oilRadiatorLeak', 'Oil cooler leak' }, { 'headGasketDamaged', 'Head gasket' },
    { 'pistonRingsDamaged', 'Piston rings' }, { 'rodBearingsDamaged', 'Rod bearings' }, { 'impactDamage', 'Engine impact damage' } }) do
    if damageTracker.getDamage('engine', e[1]) then out[#out + 1] = { k = e[1], n = e[2], f = 1 } end
  end
end)
obj:queueGameEngineLua('if TreadXLGPS and TreadXLGPS.onPartDamage then TreadXLGPS.onPartDamage(' .. serialize(out) .. ', "@TAG@") end')
]==]

function Dmg.energy()
  local pv = playerVehicle()
  if not pv then return nil end
  local ok, id = pcall(function() return pv:getID() end)
  local o = ok and map and type(map.objects) == 'table' and map.objects[id] or nil
  return o and tonumber(o.damage) or nil
end

function Dmg.ask(tag)
  local pv = playerVehicle()
  if not pv then return end
  local code = Dmg.VLUA:gsub('@TAG@', tag)
  pcall(function() pv:queueLuaCommand(code) end)
end

-- a new run: what's already broken doesn't count
function Dmg.start()
  Dmg.base, Dmg.last, Dmg.pending, Dmg.rebaseAt = {}, nil, nil, nil
  if race then race.hits = {} end
  if Dmg.on then Dmg.ask('base') end
end

-- every HUD tick while racing
function Dmg.tick()
  if not (Dmg.on and race and race.state == 'running') then return end
  local e = Dmg.energy()
  if e then
    if not Dmg.last then Dmg.last = e
    elseif e < Dmg.last - 1 then Dmg.last = e; Dmg.ask('base') -- repaired (reset / recovery): a new starting point
    elseif e - Dmg.last >= Dmg.STEP and not Dmg.pending then
      Dmg.pending = { at = clock + Dmg.SETTLE, t = raceClock - race.t0, rm = progress and progress.s or 0 }
    end
  end
  local p = Dmg.pending
  if p and not p.asked and clock >= p.at then
    p.asked, p.at = true, clock + 3
    Dmg.last = e or Dmg.last
    Dmg.ask('hit')
  elseif p and p.asked and clock >= p.at then
    Dmg.pending = nil -- no answer from the vehicle
  end
  if Dmg.rebaseAt and clock >= Dmg.rebaseAt then Dmg.rebaseAt = nil; Dmg.ask('base') end
end

-- the vehicle's answer: parts that got at least MIN_RISE % worse since the last look make one "hit"
function Dmg.receive(list, tag)
  if type(list) ~= 'table' then return end
  local now = {}
  for _, p in pairs(list) do if type(p) == 'table' and p.k then now[tostring(p.k)] = p end end
  local pend = Dmg.pending
  if tag == 'hit' and pend and race and race.state == 'running' then
    local best, order = {}, {}
    for k, p in pairs(now) do
      local was = Dmg.base[k]
      local rise = p.f and (was and 0 or 100) or ((tonumber(p.d) or 0) - (was and tonumber(was.d) or 0))
      if rise >= Dmg.MIN_RISE then
        local n = trim((tostring(p.n or k):gsub('[%c|,]', ' '):gsub('%s+', ' '))):sub(1, 60)
        if n == '' or n == 'Unknown' then n = 'Unknown part' end
        if not best[n] then order[#order + 1] = n end
        if not best[n] or rise > best[n].rise then best[n] = { n = n, rise = rise, d = tonumber(p.d), f = p.f } end
      end
    end
    local hit = {}
    for _, n in ipairs(order) do hit[#hit + 1] = best[n] end
    table.sort(hit, function(a, b) if a.rise ~= b.rise then return a.rise > b.rise end return a.n < b.n end)
    if #hit > 0 then
      local txt = {}
      for i = 1, math.min(#hit, Dmg.MAX_PARTS) do txt[i] = hit[i].f and hit[i].n or string.format('%s %d%%', hit[i].n, hit[i].d or 0) end
      if #hit > Dmg.MAX_PARTS then txt[#txt + 1] = '+' .. (#hit - Dmg.MAX_PARTS) .. ' more' end
      race.hits = race.hits or {}
      race.hits[#race.hits + 1] = { t = pend.t, rm = pend.rm, parts = txt }
    end
  end
  if tag == 'hit' then Dmg.pending = nil end
  Dmg.base = now
end

-- ------------------------------------------------------------------ run log (settings/TreadXLGPS/race_log.txt)
-- One short line per timed run: computer date, time and time zone, map, course, time (or DNF), vehicle, how many
-- off-course / wrong-way / speeding / missed-VCP / jump-start warnings, resets and recoveries it had and the time spent
-- off course; then one indented line per off-course moment (and per damage hit when the damage log is on).
local RunLog = {
  FILE = USER_ROOT .. '/race_log.txt',   -- timed runs (all maps), newest last
  MAX = 500,                            -- runs kept
  MAX_SUB = 50,                         -- off-course moments / damage hits written per run
  COUNTED = { offCourse = true, wrongWay = true, overspeed = true },
  quietUntil = 0,                       -- vehicle resets until then are the end of a recovery, not a reset
  recoverAt = nil,                      -- when the last recovery (Insert) started
  recovering = false,                   -- a recovery is going on
}
RunLog.FIELDS = { { 'offCourse', 'Off course' }, { 'wrongWay', 'Wrong way' }, { 'overspeed', 'Speeding' }, { 'vcpMissed', 'Missed VCPs' }, { 'jump', 'Jump starts' },
  { 'reset', 'Resets' }, { 'recover', 'Recoveries' } }

function RunLog.fmt(t)
  t = math.max(0, tonumber(t) or 0)
  local tenths = floor(t * 10 + 1e-6) -- truncated like the race clock on the screen
  local d, sec, mn, hr = tenths % 10, floor(tenths / 10) % 60, floor(tenths / 600) % 60, floor(tenths / 36000)
  if hr > 0 then return string.format('%d:%02d:%02d.%d', hr, mn, sec, d) end
  return string.format('%d:%02d.%d', mn, sec, d)
end

-- the computer's time zone as UTC+hh:mm (plus its name when the system gives one)
function RunLog.tz()
  local now = os.time()
  local diff = os.difftime(now, os.time(os.date('!*t', now)))
  local lt = os.date('*t', now)
  if lt and lt.isdst then diff = diff + 3600 end
  local sign = diff < 0 and '-' or '+'
  diff = abs(diff)
  local out = string.format('UTC%s%02d:%02d', sign, floor(diff / 3600), floor(diff % 3600 / 60))
  local name = os.date('%Z', now)
  if type(name) == 'string' and name ~= '' and not name:match('^[%+%-]?%d+$') then out = out .. ' (' .. name .. ')' end
  return out
end

-- "Gavril D-Series 4WD (pickup)": brand, name and configuration like the game's vehicle-switch message
function RunLog.vehicle()
  local pv = playerVehicle()
  if not pv then return 'unknown' end
  local jb = nil
  pcall(function() jb = pv.JBeam or pv:getJBeamFilename() end)
  local parts = {}
  pcall(function()
    local info = core_vehicles.getModel(jb)
    if info and info.model then
      parts[#parts + 1] = info.model.Brand
      parts[#parts + 1] = info.model.Name
      local key = tostring(pv.partConfig or ''):match('vehicles/' .. jb .. '/(.*)%.pc')
      local cfg = key and info.configs and info.configs[key]
      if cfg and cfg.Configuration then parts[#parts + 1] = cfg.Configuration end
    end
  end)
  local name = trim(table.concat(parts, ' '))
  if name == '' then return tostring(jb or 'unknown') end
  return name .. (jb and (' (' .. jb .. ')') or '')
end

-- the driver written into the run log: the name set in Display (else the BeamMP nickname) and the race number
RunLog.name, RunLog.number = '', ''
function RunLog.clean(v, n) return trim(tostring(v or ''):gsub('[|\r\n%c]', ' '):gsub('%s+', ' ')):sub(1, n) end
function RunLog.driverName()
  if race and race.driver then return race.driver end -- who started this run (a dropped connection doesn't change it)
  local L = M._lock and M._lock.LOGIN
  if L and L.applies() then return (L.current()) or RunLog.name end -- v3.1.7: the signed-in name (BeamMP name first)
  if RunLog.name ~= '' then return RunLog.name end
  local nick = ''
  pcall(function() if type(MPConfig) == 'table' and type(MPConfig.getNickname) == 'function' then nick = MPConfig.getNickname() end end)
  return RunLog.clean(nick, 40)
end
function RunLog.session()
  local L = M._lock
  if L and L.server then return 'Baja75 server' end
  local ok, cur = pcall(function() return L and L.current() end)
  return (ok and cur) and 'BeamMP' or 'Single player'
end
function RunLog.newId()
  local h = 0
  for _, c in ipairs({ os.time(), floor(os.clock() * 1000), math.random(0, 0xffffff) }) do h = (h * 31 + c) % 4294967296 end
  return string.format('%08x%06x', floor(os.time()) % 4294967296, (h + math.random(0, 0xffffff)) % 16777216)
end
function M.setDriver(name, number)
  RunLog.name, RunLog.number = RunLog.clean(name, 40), RunLog.clean(number, 8)
end
function M._who() return RunLog.driverName() end -- who is recording (saved with the course, v3.1.7)

-- v3.1.6: on a BeamMP server, the Adventure (full), Rally, Track and Chase Editions also send each run to the server's
-- results collector (Resources/Server/Baja75Results). The server keeps it only when the course is one of its own (same map,
-- name and route length) and answers; servers without the collector never answer, and nothing is shown.
RunLog.SEND = { full = true, rally = true, track = true, chase = true }
RunLog.ACK = {
  saved = { 'success', 'Result sent to the server: %s' },
  not_server_course = { 'info', '%s is not one of this server\'s courses: the result stays on your unit' },
  write = { 'warning', 'The server could not save your result for %s: send your run log (MENU > Times > Export)' },
  bad = { 'warning', 'The server did not accept your result for %s: send your run log (MENU > Times > Export)' },
  busy = { 'warning', 'The server did not take your result for %s (too soon after the last one): send your run log' },
}
function RunLog.onAck(data)
  local ok, t = pcall(jsonDecode, data)
  if not ok or type(t) ~= 'table' then return end
  local a = RunLog.ACK[tostring(t.why)]
  if not a then return end -- 'duplicate': already there
  local name = RunLog.clean(t.course, 60)
  toast(string.format(a[2], name ~= '' and name or 'this run'), a[1])
end
function RunLog.toServer(run)
  if not RunLog.SEND[PNK.EDITION] or type(TriggerServerEvent) ~= 'function' or type(jsonEncode) ~= 'function' then return false end
  local ok, mp = pcall(function() return MPCoreNetwork.isMPSession() end)
  if not (ok and mp) then return false end
  if not (race and course and course.name == race.name and (course.length or 0) > 0) then return false end
  if type(AddEventHandler) == 'function' then pcall(AddEventHandler, 'Baja75Results_ack', RunLog.onAck, 'TreadXLGPS_results') end
  local msg = { v = 1, ed = PNK.EDITION, unit = VERSION, map = levelId(), course = race.name, length = r2(course.length), lines = run }
  local sent = pcall(function() TriggerServerEvent('Baja75Results_run', jsonEncode(msg)) end)
  if not sent then log_('W', 'could not send the run to the server') end
  return sent
end

-- an off-course moment still open when the run ends lasts until then
function RunLog.closeSeg(t)
  if race and race.seg then race.seg.dur = math.max(0, t - race.seg.t); race.seg = nil end
end

function RunLog.offTime()
  local sum = 0
  for _, sg in ipairs(race and race.segs or {}) do sum = sum + (sg.dur or 0) end
  return sum
end

function RunLog.write(finished, t)
  if not race then return end
  RunLog.closeSeg(t)
  local c = race.counts or {}
  local _, missed = vcpCounts()
  c.vcpMissed = missed
  local parts = {
    os.date('%Y-%m-%d %H:%M:%S') .. ' ' .. RunLog.tz(),
    'Map: ' .. levelId(),
    'Course: ' .. tostring(race.name):gsub('_', ' '),
    'Time: ' .. (finished and RunLog.fmt(t) or ('DNF after ' .. RunLog.fmt(t))),
    'Vehicle: ' .. RunLog.vehicle(),
  }
  for _, f in ipairs(RunLog.FIELDS) do parts[#parts + 1] = f[2] .. ': ' .. tostring(c[f[1]] or 0) end
  parts[#parts + 1] = 'Time off course: ' .. RunLog.fmt(RunLog.offTime())
  if Dmg.on then parts[#parts + 1] = 'Damage: ' .. tostring(#(race.hits or {})) end
  -- for scoring programs (v3.1.5): who drove, the exact time, VCPs, where it was run, which unit, and an id for this run
  local who = RunLog.driverName()
  if who ~= '' then parts[#parts + 1] = 'Driver: ' .. who end
  if RunLog.number ~= '' then parts[#parts + 1] = 'Number: ' .. RunLog.number end
  parts[#parts + 1] = 'Time ms: ' .. string.format('%d', floor(math.max(0, tonumber(t) or 0) * 1000 + 0.5))
  local cleared, _, total = vcpCounts()
  if total > 0 then parts[#parts + 1] = 'VCPs: ' .. cleared .. '/' .. total end
  parts[#parts + 1] = 'Session: ' .. RunLog.session()
  parts[#parts + 1] = 'Unit: v' .. VERSION
  parts[#parts + 1] = 'Run ID: ' .. RunLog.newId()
  local run = { (table.concat(parts, ' | '):gsub('[\r\n]', ' ')) }
  local function mi(m) return string.format('%.2f mi', (tonumber(m) or 0) / 1609.344) end
  -- each off-course moment: race clock when it started (the timing node), race mile, how long, resets / recoveries in it
  for i, sg in ipairs(race.segs or {}) do
    if i > RunLog.MAX_SUB then run[#run + 1] = string.format('  ... %d more off-course moments', #race.segs - RunLog.MAX_SUB); break end
    run[#run + 1] = string.format('  Off course %d | At: %s | RM: %s | Off for: %s | Resets: %d | Recoveries: %d',
      i, RunLog.fmt(sg.t), mi(sg.rm), RunLog.fmt(sg.dur or 0), sg.resets or 0, sg.recovers or 0)
  end
  if Dmg.on then
    for i, h in ipairs(race.hits or {}) do
      if i > RunLog.MAX_SUB then run[#run + 1] = string.format('  ... %d more damage hits', #race.hits - RunLog.MAX_SUB); break end
      run[#run + 1] = (string.format('  Damage %d | At: %s | RM: %s | Parts: %s', i, RunLog.fmt(h.t), mi(h.rm), table.concat(h.parts or {}, ', ')):gsub('[\r\n]', ' '))
    end
  end
  -- runs already in the file (a run = its line + its indented lines); keep the newest MAX
  local runs, cur = {}, nil
  for l in ((readText(RunLog.FILE) or '') .. '\n'):gmatch('([^\n]*)\n') do
    l = l:gsub('\r$', '')
    if l:match('^%s') then
      if cur then cur[#cur + 1] = l end
    elseif l ~= '' then
      cur = { l }
      runs[#runs + 1] = cur
    end
  end
  runs[#runs + 1] = run
  while #runs > RunLog.MAX do table.remove(runs, 1) end
  local lines = {}
  for _, r in ipairs(runs) do for _, l in ipairs(r) do lines[#lines + 1] = l end end
  if not writeText(RunLog.FILE, table.concat(lines, '\n') .. '\n') then log_('E', 'could not write ' .. RunLog.FILE) end
  RunLog.toServer(run)
end

-- warnings counted once each time they come on during a run; each OFF COURSE opens an off-course moment that lasts
-- until the warning clears (the alert carries how long it has been, forT)
function RunLog.count(alerts)
  if not (race and race.state == 'running') then return end
  race.counts = race.counts or {}
  race.segs = race.segs or {}
  local now, t = {}, raceClock - race.t0
  for _, a in ipairs(alerts or {}) do
    if RunLog.COUNTED[a.kind] then
      now[a.kind] = true
      if not (race.active or {})[a.kind] then race.counts[a.kind] = (race.counts[a.kind] or 0) + 1 end
    end
  end
  if now.offCourse and not race.seg then
    race.seg = { t = t, rm = progress and progress.s or 0, resets = 0, recovers = 0 }
    race.segs[#race.segs + 1] = race.seg
  elseif race.seg and not now.offCourse then
    RunLog.closeSeg(t)
  end
  if race.seg then
    for _, a in ipairs(alerts or {}) do if a.kind == 'offCourse' then a.forT = r2(t - race.seg.t) end end
  end
  race.active = now
end

-- a vehicle reset or recovery during a run (and inside the off-course moment it happened in)
function RunLog.event(kind)
  if not (race and race.state == 'running') then return end
  race.counts = race.counts or {}
  race.counts[kind] = (race.counts[kind] or 0) + 1
  if race.seg then
    local f = kind == 'reset' and 'resets' or 'recovers'
    race.seg[f] = (race.seg[f] or 0) + 1
  end
end

-- recoveries (Insert). The vehicle's own recovery code tells the GPS (RunLog.VLUA, put in the player's vehicle while a
-- race is set up), and so does the game's onStartRecovering hook in the game versions that send it (it has no vehicle id).
-- However many of these one recovery sends, it counts once.
RunLog.VLUA = [==[
if recovery and type(recovery.startRecovering) == 'function' and not recovery.__txl then
  recovery.__txl = true
  local id, s0, s1 = obj:getId(), recovery.startRecovering, recovery.stopRecovering
  local function tell(what) obj:queueGameEngineLua('if TreadXLGPS and TreadXLGPS.vehRecovery then TreadXLGPS.vehRecovery(' .. id .. ', "' .. what .. '") end') end
  recovery.startRecovering = function(...) tell('start') return s0(...) end
  if type(s1) == 'function' then recovery.stopRecovering = function(...) tell('stop') return s1(...) end end
end]==]
function RunLog.hookVehicle(pv)
  if not pv then return end
  local ok, id = pcall(function() return pv:getID() end)
  if not ok or not id or (RunLog.hookedId == id and clock - (RunLog.hookedAt or -99) < 5) then return end
  RunLog.hookedId, RunLog.hookedAt = id, clock -- again every 5 s: a reloaded vehicle (Ctrl+R) starts without it
  pcall(function() pv:queueLuaCommand(RunLog.VLUA) end)
end
function RunLog.recoverStart(src)
  if RunLog.recovering and RunLog.recoverAt and clock - RunLog.recoverAt < 30 then return end -- the same recovery
  RunLog.recovering, RunLog.recoverAt = true, clock
  local p = Dmg.pending
  if p and not p.asked then p.at = clock end -- a hit just before: look at the parts before they get fixed
  if race and race.state == 'running' then log_('I', 'recovery (' .. tostring(src) .. ')') end
  RunLog.event('recover')
end
function RunLog.recoverStop()
  RunLog.recovering = false
  RunLog.quietUntil = clock + 1.5 -- the vehicle is put back now: the game reports that as a reset
  Dmg.rebaseAt = clock + 1
end

local function raceGo()
  resetRun()
  track.i = 1 -- start the course tracker at the beginning (a loop's start and finish are in the same place)
  race.state, race.t0, race.splits, race.prevS, race.prevT = 'running', raceClock, {}, nil, nil
  race.counts, race.active = { jump = race.jumps or 0, reset = 0, recover = 0 }, {}
  race.segs, race.seg = {}, nil
  race.driver = nil
  race.driver = RunLog.driverName()
  Dmg.start()
  raceCall('countdowngo', 'event:UI_CountdownGo')
end

local function raceFinish(t)
  local times = readTimes(race.name)
  local cleared, missed, total = vcpCounts()
  local prevBest = times.best
  local isBest = not prevBest or t < prevBest
  if isBest then times.best = floor(t * 1000 + 0.5) / 1000 end
  local model = nil
  local pv = playerVehicle()
  if pv then pcall(function() model = pv:getJBeamFilename() end) end
  table.insert(times.runs, 1, { t = floor(t * 1000 + 0.5) / 1000, date = os.date('%Y-%m-%d %H:%M'), cleared = cleared, missed = missed, total = total, vehicle = model })
  for i = #times.runs, RUNS_KEPT + 1, -1 do times.runs[i] = nil end
  local saved = writeJson(timesPath(race.name), times, true)
  race.state, race.best = 'finished', times.best
  race.result = { t = r2(t), best = times.best, prevBest = prevBest, isBest = isBest, cleared = cleared, missed = missed, total = total, saved = saved or nil }
  race.finishedAt = clock
  RunLog.write(true, t)
  local rc = race.counts or {}
  race.result.offCourse, race.result.wrongWay, race.result.overspeed, race.result.jump = rc.offCourse or 0, rc.wrongWay or 0, rc.overspeed or 0, rc.jump or 0
  race.result.reset, race.result.recover, race.result.offTime = rc.reset or 0, rc.recover or 0, r2(RunLog.offTime())
  race.result.damage = Dmg.on and #(race.hits or {}) or nil
  race.jumps = 0
  playSfx('event:UI_CountdownGo')
  log_('I', string.format('race "%s" finished in %.2f s (best %.2f)', race.name, t, times.best or t))
end

-- runs every HUD tick after the course progress; returns the alerts to show instead of the course ones (or nil)
local function updateRace()
  if not race then return nil end
  if not course or course.name ~= race.name or course.source ~= race.source then race = nil; return nil end
  local d = raceDistToStart()
  if race.state == 'finished' and d and d <= RACE_START_RADIUS and clock - (race.finishedAt or 0) > 10 then
    race.state = 'staging' -- back on the line: ready to go again
  end
  if race.state == 'staging' then
    -- course alerts don't apply before the start: say where to go instead
    if d and d <= RACE_START_RADIUS then return { { kind = 'raceReady', level = 'ok' } } end
    return { { kind = 'raceStaging', level = 'info', meters = d and floor(d + 0.5) or nil } }
  elseif race.state == 'countdown' then
    local left = race.cdEnd - raceClock
    if d and d > RACE_JUMP then
      race.state = 'staging'
      race.jumps = (race.jumps or 0) + 1
      pushTransient({ kind = 'raceJump', level = 'danger' }, 4)
      if PN then PN.clear() end
      raceCall('falseStart', 'event:UI_Checkpoint')
      return {}
    end
    if left <= 0 then raceGo(); return nil end
    local n = math.ceil(left)
    if n ~= race.lastBeep then
      race.lastBeep = n
      if n <= 5 then raceCall('countdown' .. n, n == 2 and 'event:UI_Countdown2' or n == 1 and 'event:UI_Countdown3' or 'event:UI_Countdown1') end
    end
    return {}
  elseif race.state == 'running' and progress then
    -- finish line: RACE_FINISH_BEFORE m before the end of the line, crossed on course after most of the course
    local line = math.max(0, course.length - RACE_FINISH_BEFORE)
    local s = progress.s
    if progress.off <= OFF_COURSE and s >= line and runStartS and s - runStartS > course.length * 0.5 then
      local t = raceClock - race.t0
      if race.prevS and race.prevT and race.prevS < line and s > race.prevS then
        t = race.prevT + (t - race.prevT) * (line - race.prevS) / (s - race.prevS) -- when the line was crossed
      end
      raceFinish(t)
    else
      race.prevS, race.prevT = s, raceClock - race.t0
    end
  end
  return nil
end

-- ------------------------------------------------------------------ pacenote calls on a loaded course
function PNC.pnShowNative(w, tiles)
  if not (pnOpts.native and guihooks and guihooks.trigger and tiles and #tiles > 0) then return end
  pnRun.serial = pnRun.serial + 1
  pnRun.shown[w.id] = pnRun.serial
  local out, base = {}, ('txl_' .. tostring(w.name or w.id)):gsub(' ', '_')
  for i, t in ipairs(tiles) do
    local c = {}
    for k, v in pairs(t) do c[k] = v end
    c.id, c.pnId = string.format('%s_%d_%d', base, w.id, i), w.id
    out[i] = c
  end
  pcall(guihooks.trigger, 'showVisualPacenote2', { pacenoteId = w.id, pacenoteName = w.name, visualPacenotes = out, serialNo = pnRun.serial })
end

function PNC.pnHideNative(w)
  local serial = w and pnRun.shown[w.id]
  if serial then
    pnRun.shown[w.id] = nil
    if guihooks and guihooks.trigger then pcall(guihooks.trigger, 'clearOneVisualPacenote', serial) end
  end
end

function PNC.pnCallsOn()
  if not PN or pnOpts.calls == 'off' or not soundOn or PNK.ed() == 'chase' or PNK.ed() == 'onyx' then return false end
  if not PN.voice() then PN.setVoice(pnOpts.voice) end
  if pnOpts.calls == 'race' then return race ~= nil and race.state == 'running' end
  return true
end

-- every HUD tick: the co-driver reads each note ahead of time (timed to your speed), linked notes together
function PNC.pnTick(wrongWay)
  if not (PN and course and course.pacenotes and #course.pacenotes > 0 and progress and me and course.hasLine) then return end
  if race and (race.state == 'staging' or race.state == 'countdown') then return end
  local list, s = course.pacenotes, progress.s
  -- after a reset / teleport: carry on from the next note ahead
  if pnRun.lastS and abs(s - pnRun.lastS) > 150 then
    PN.clear(); PNC.pnClearNative()
    pnRun.idx = 1
    while list[pnRun.idx] and list[pnRun.idx].s < s - 5 do pnRun.idx = pnRun.idx + 1 end
  end
  pnRun.lastS = s
  -- notes behind you (passed, or joined mid-course) are done
  for i = math.max(1, pnRun.idx - 4), pnRun.idx - 1 do
    local w = list[i]
    if w and s > w.s + (w.pn.arc or 15) then PNC.pnHideNative(w) end
  end
  if progress.off > OFF_COURSE or wrongWay then return end
  while list[pnRun.idx] and list[pnRun.idx].s < s - 5 do PNC.pnHideNative(list[pnRun.idx]); pnRun.idx = pnRun.idx + 1 end
  if not PNC.pnCallsOn() then return end
  local w = list[pnRun.idx]
  local lead = math.max(PNK.MIN_LEAD, me.speed * ((PNK.LEAD[pnOpts.lead] or PNK.LEAD.normal) + PN.queuedSeconds(clock)))
  if not w or w.s - s > lead then return end
  local entries, i, chaseCalls = {}, pnRun.idx, pnOpts.style == 'chase' and PN.chasePhrases
  repeat
    local n = list[i]
    for _, ph in ipairs(chaseCalls and PN.chasePhrases(n.pn) or PN.phrases(n.pn)) do entries[#entries + 1] = ph end
    -- distances and "into" / "and" only in the full calls (Chase mode: direction, cautions and extras only)
    if n.call and not chaseCalls then entries[#entries + 1] = { text = n.call, cat = n.link and 'link' or 'distance' } end
    PNC.pnShowNative(n, n.vis)
    i = i + 1
  until not (n.link and list[i]) or i - pnRun.idx >= 3
  PN.enqueue(entries)
  pnRun.idx = i
end

function PNC.pnForHud()
  if not (PN and course and course.pacenotes and #course.pacenotes > 0) then return nil end
  local list, out = course.pacenotes, {}
  local s = progress and progress.s
  local i = pnRun.idx
  if not s then return nil end
  while list[i] and list[i].s < s - 5 do i = i + 1 end
  -- notes already called but not passed yet stay first in the bar
  for j = math.max(1, i - 3), i - 1 do
    local w = list[j]
    if w and s <= w.s + (w.pn.arc or 15) and s >= w.s - 400 then out[#out + 1] = { id = w.id, ahead = r2(w.s - s), vis = w.vis, text = w.name, called = true, pn = w.pn } end
  end
  for j = i, #list do
    local w = list[j]
    if #out >= 3 or w.s - s > 1500 then break end
    out[#out + 1] = { id = w.id, ahead = r2(w.s - s), vis = w.vis, text = w.name, called = j < pnRun.idx or nil, pn = w.pn }
  end
  for _, o in ipairs(out) do -- Chase mode shows words: "SHARP LEFT", "CAUTION · CREST"
    if pnOpts.style == 'chase' and PN.chaseText then o.ct, o.cx = PN.chaseText(o.pn) end
    o.pn = nil
  end
  return { next = out, total = #list, calls = PNC.pnCallsOn() or nil, voice = PN.voice() and PN.voice().label or nil, style = pnOpts.style }
end

local function raceForHud()
  if not race then return nil end
  local h = { state = race.state, name = race.name, best = race.best }
  if race.state ~= 'running' then
    local d = raceDistToStart()
    local sx, sy = raceStartPoint()
    h.dist = d and r2(d) or nil
    h.ready = d ~= nil and d <= RACE_START_RADIUS
    h.sx, h.sy = sx and r2(sx), sy and r2(sy)
  end
  if race.state == 'countdown' then h.count = r2(math.max(0, race.cdEnd - raceClock)) end
  if race.state == 'running' then
    h.t = r2(raceClock - race.t0)
    local sp = {}
    for i = math.max(1, #race.splits - 2), #race.splits do sp[#sp + 1] = race.splits[i] end
    h.splits = sp
  end
  if race.result then h.result = race.result; h.resultAge = r2(clock - (race.finishedAt or clock)) end
  return h
end

local function buildHud()
  local hud = { ok = me ~= nil, trip = r2(trip), maxSpeed = r2(maxSpeed), tod = timeOfDaySeconds(), tempC = airTempC() }
  if me then
    hud.x, hud.y, hud.z = r2(me.x), r2(me.y), r2(me.z)
    hud.speed = r2(me.speed)
    hud.heading = floor(me.heading + 0.5) % 360
  end
  if rec then
    hud.rec = { name = rec.name, dist = r2(rec.dist), marks = #rec.wpts, pts = #rec.pts }
  end
  local alerts, zone = updateCourse()
  local raceAlerts = updateRace()
  if raceAlerts then alerts = raceAlerts end
  RunLog.count(alerts)
  local wrongWay = false
  for _, a in ipairs(alerts or {}) do if a.kind == 'wrongWay' then wrongWay = true end end
  PNC.pnTick(wrongWay)
  if course then
    hud.course = { name = course.name, length = r2(course.length), hasLine = course.hasLine }
    if progress then
      hud.course.s = r2(progress.s)
      hud.course.off = r2(progress.off)
      hud.course.toFinish = r2(math.max(0, course.length - progress.s))
    end
    hud.next = nextWaypoints(4)
    hud.nextVcp = nextOfKind('vcp', true)
    hud.nextPit = nextOfKind('pit')
    local cleared, missed, total = vcpCounts()
    hud.vcps = { cleared = cleared, missed = missed, total = total }
    local st = {}
    for id, v in pairs(vcpState) do st[#st + 1] = { id = id, st = v } end
    hud.vcpStates = st
  elseif rec then
    -- recording without a course: show the latest marks, newest first, with distance back to them
    local list = {}
    for i = #rec.wpts, math.max(1, #rec.wpts - 3), -1 do
      local w = rec.wpts[i]
      list[#list + 1] = { id = w.id, label = w.name or w.label or 'Waypoint', icon = w.icon, kind = w.kind,
        behind = me and r2(sqrt((w.x - me.x) ^ 2 + (w.y - me.y) ^ 2)) or nil, limitMph = w.limitMph,
        vis = w.kind == 'pacenote' and PN and PN.visual(w.pn) or nil }
    end
    hud.marks = list
  end
  hud.zone = zone
  hud.alert = PNK.EDITION ~= 'onyx' and pickAlert(alerts) or nil -- (Onyx: no driving alerts, the route is a map aid)
  hud.chase = updateChase()
  hud.others = nearbyVehicles()
  hud.field = M._field and M._field.update() or nil -- players on the course ahead of you
  hud.race = raceForHud()
  hud.pacenotes = PNC.pnForHud()
  return hud
end

-- ------------------------------------------------------------------ public API (called from the UI / input actions)
local function sendHello(fromUi)
  local boot = fromUi and bootPending and inLevel()
  if boot then bootPending = false end
  trigger('hello', { version = VERSION, edition = PNK.EDITION, level = levelId(), inLevel = inLevel(), boot = boot or nil, startupSound = startupSoundPath(),
    access = M._lock and M._lock.state() or nil }) -- the full GPS: on a Baja75 server? unlocked with the password?
end

function M.requestState()
  sendHello(true)
  sendList()
  sendCourse()
  sendRec()
  sendTrail(true)
  sendWpts()
  sendChaseTargets()
  M.listWptIcons()
  M.requestPacenoteInfo()
end

function M.list() sendList() end
function M.loadCourse(name, source) race = nil; loadCourse(name, source) end
function M.unloadCourse() race = nil; unloadCourse() end

-- race timing: load a route in race mode, start the countdown on the line, end it
function M.raceRoute(name, source, startNow) raceRoute(name, source, startNow == true) end
function M.raceStart() raceStartCountdown() end
function M.raceToStart() raceTeleportToStart() end
function M.raceEnd()
  if not race then return end
  if race.state == 'running' and race.t0 then RunLog.write(false, raceClock - race.t0) end
  race = nil
  toast('Race ended', 'info')
end

-- MENU > Times: the run log, newest first (each run with its off-course moments and damage hits)
function RunLog.split(l)
  local t = {}
  for p in (l .. ' | '):gmatch('(.-) | ') do t[#t + 1] = p end
  return t
end

function RunLog.read()
  local out, cur = {}, nil
  for l in ((readText(RunLog.FILE) or '') .. '\n'):gmatch('([^\n]*)\n') do
    l = l:gsub('\r$', '')
    if l:match('^%s') then
      -- "  Off course 1 | At: 0:32.1 | RM: 0.40 mi | Off for: 0:05.2 | Resets: 0 | Recoveries: 1"
      -- "  Damage 1 | At: 0:45.3 | RM: 0.61 mi | Parts: Front Bumper 40%, Flat tire FL"
      if cur then
        local f = RunLog.split(trim(l))
        local kv = {}
        for i = 2, #f do
          local k, v = f[i]:match('^([^:]+): (.*)$')
          if k then kv[k] = v end
        end
        if f[1]:match('^Off course %d+$') then
          cur.segs[#cur.segs + 1] = { at = kv['At'], rm = kv['RM'], dur = kv['Off for'], resets = tonumber(kv['Resets']) or 0, recovers = tonumber(kv['Recoveries']) or 0 }
        elseif f[1]:match('^Damage %d+$') then
          cur.hits[#cur.hits + 1] = { at = kv['At'], rm = kv['RM'], parts = kv['Parts'] or '' }
        elseif f[1]:match('^%.%.%.') then
          cur.more = (cur.more and cur.more .. ', ' or '') .. f[1]:gsub('^%.%.%.%s*', '')
        end
      end
    elseif l ~= '' then
      local e = { counts = {}, segs = {}, hits = {} }
      for i, part in ipairs(RunLog.split(l)) do
        if i == 1 then e.when = part
        else
          local k, v = part:match('^([^:]+): (.*)$')
          if k == 'Map' then e.map = v elseif k == 'Course' then e.course = v elseif k == 'Time' then e.time = v
          elseif k == 'Vehicle' then e.vehicle = v
          elseif k == 'Time off course' then e.offTime = v
          elseif k == 'Driver' then e.driver = v elseif k == 'Number' then e.number = v elseif k == 'VCPs' then e.vcps = v
          elseif k == 'Session' then e.session = v elseif k == 'Time ms' or k == 'Unit' or k == 'Run ID' then e[k == 'Run ID' and 'id' or k == 'Unit' and 'unit' or 'ms'] = v
          elseif k then e.counts[#e.counts + 1] = { k = k, n = tonumber(v) or 0 } end
        end
      end
      table.insert(out, 1, e)
      cur = e
    end
  end
  return out
end

-- MENU > Times > Export for scoring: a copy of the run log named after the driver, in settings/TreadXLGPS/exports
function M.exportRunLog()
  local text = readText(RunLog.FILE)
  if not text or text == '' then toast('No timed runs to export yet', 'warning'); return end
  local who = RunLog.driverName():gsub('[^%w%-]+', '_'):gsub('^_+', ''):gsub('_+$', '')
  if who == '' then who = 'driver' end
  local num = RunLog.number:gsub('[^%w]+', '')
  local file = USER_ROOT .. '/exports/Baja75_results_' .. who .. (num ~= '' and ('_' .. num) or '') .. '_' .. os.date('%Y%m%d_%H%M%S') .. '.txt'
  if not writeText(file, text) then toast('Could not write ' .. file:sub(2), 'warning'); return end
  toast('Saved ' .. file:sub(2), 'success')
  if not openFolder(USER_ROOT .. '/exports') then log_('I', 'export: ' .. file) end
  local real = realPath(USER_ROOT .. '/exports')
  trigger('runLogExported', { path = file:sub(2), real = real and (real .. '/' .. file:match('[^/]+$')) or nil })
end

function M.requestRunLog()
  local list = RunLog.read()
  local shown = {}
  for i = 1, math.min(#list, 100) do shown[i] = list[i] end
  trigger('runLog', { entries = shown, total = #list, path = RunLog.FILE:sub(2), real = realPath(USER_ROOT) and (realPath(USER_ROOT) .. '/race_log.txt') or nil })
end

-- sounds (the UI's Sound setting); the start-up chime falls back to the game's audio when the UI can't play it
function M.setSound(on) soundOn = on == true end
function M.playSound(name, vol)
  vol = tonumber(vol) or 0.48
  if vol < 0 then vol = 0 elseif vol > 1 then vol = 1 end
  if name == 'startup' then playSfx(startupSoundPath(), vol) end
end


-- notes, picture and best time of one course, for MENU > Courses
local function readNotes(dir, name)
  local text = readText(dir .. '/' .. name .. '.notes.txt')
  if not text then return nil end
  local lines = {}
  for line in (text .. '\n'):gmatch('([^\n]*)\n') do
    line = line:gsub('\r$', '')
    if not line:match('^%s*#') then lines[#lines + 1] = line end
  end
  local out = trim(table.concat(lines, '\n'))
  if out == '' then return nil end
  if #out > 2000 then out = out:sub(1, 2000) .. '...' end
  return out
end

local function findPicture(dir, name, noMap)
  for _, ext in ipairs({ 'png', 'jpg', 'jpeg', 'map.jpg' }) do
    local p = dir .. '/' .. name .. '.' .. ext
    if fileExists(p) and not (noMap and ext == 'map.jpg') then return p end
  end
  return nil
end

function M.courseInfo(name, source)
  name = safeName(name)
  local dir, src = findCourse(name, source)
  if not dir then return end
  local times = readTimes(name)
  local pn, auto = 0, 0
  for _, w in ipairs(readJson(wptPath(dir, name)) or {}) do
    if type(w) == 'table' and w.icon == PNK.ICON then pn = pn + 1; if w.auto then auto = auto + 1 end end
  end
  local cdata = readJson(coursePath(dir, name))
  trigger('courseInfo', {
    name = name, source = src, notes = readNotes(dir, name), image = findPicture(dir, name),
    best = times.best, runs = #times.runs, last = times.runs[1], pacenotes = pn, autoPacenotes = auto,
    author = type(cdata) == 'table' and type(cdata.author) == 'string' and cdata.author or nil, -- who recorded it (v3.1.7)
  })
end

local function notesTemplate(name, c)
  local n = { vcp = 0, zone = 0, pit = 0 }
  for _, w in ipairs(c.wpts) do if n[w.kind] then n[w.kind] = n[w.kind] + 1 end end
  return table.concat({
    '# Baja75 Navigation Unit course notes: racers see this text in MENU > Courses when they pick ' .. name .. '.',
    '# Lines starting with # stay hidden. Put a picture next to this file as ' .. name .. '.png or ' .. name .. '.jpg.',
    '# Write anything useful: where the start is, rules, vehicle class, pits, install notes.',
    '',
    string.format('%s - %.1f mi (%.1f km), %d VCPs, %d speed zones, %d pits.', name:gsub('_', ' '), c.length / 1609.344, c.length / 1000, n.vcp, n.zone, n.pit),
    '',
  }, '\n')
end

-- start (or open) the notes file of one of your courses, next to the course file
function M.editNotes(name, source)
  name = safeName(name)
  local dir, src = findCourse(name, source)
  if not dir then toast('Course not found: ' .. name, 'warning'); return end
  if src == 'server' or src == 'rally' then toast('This course is read-only - save a copy first', 'warning'); return end
  local p = dir .. '/' .. name .. '.notes.txt'
  if not fileExists(p) then
    local pts, wpts = readCourseFiles(dir, name)
    if not writeText(p, notesTemplate(name, buildCourse(name, pts, wpts))) then toast('Could not write ' .. p:sub(2), 'error'); return end
  end
  openFolder(dir)
  toast('Edit ' .. name .. '.notes.txt - add ' .. name .. '.png or .jpg for a picture', 'info')
end
function M.resetRun() resetRun(); toast('Run reset - VCPs cleared', 'info') end

local function isLoaded(name, source) return course and course.name == name and course.source == source end

function M.deleteCourse(name, source)
  name = safeName(name)
  if name == '' then return end
  if source == 'server' then toast('Server courses come from the server\'s mod and can\'t be deleted here', 'warning'); return end
  if source == 'rally' then toast('Rally Courses come with the map and can\'t be deleted', 'warning'); return end
  local dir, src = findCourse(name, source)
  if dir then
    removeFile(coursePath(dir, name))
    removeFile(wptPath(dir, name))
    toast('Deleted "' .. name .. '"', 'info')
  end
  if isLoaded(name, src) then unloadCourse() else sendList() end
end

-- rename (mine / legacy); a legacy course moves into your courses folder
function M.renameCourse(name, source, newName)
  name, newName = safeName(name), safeName(newName)
  if name == '' or newName == '' then toast('Type a new name first', 'warning'); return end
  if source == 'server' or source == 'rally' then toast('This course is read-only - save a copy first', 'warning'); return end
  local dir, src = findCourse(name, source)
  if not dir then toast('Course not found: ' .. name, 'warning'); return end
  if newName == name and src == 'mine' then return end
  if fileExists(coursePath(myDir(), newName)) then toast('"' .. newName .. '" already exists', 'warning'); return end
  local pts, wpts, cdata = readCourseFiles(dir, name)
  local tmp = buildCourse(newName, pts, wpts)
  if not saveCourseFiles(myDir(), newName, tmp.pts, tmp.wpts, cdata.author) then toast('Could not rename', 'error'); return end
  removeFile(coursePath(dir, name))
  removeFile(wptPath(dir, name))
  toast('Renamed to "' .. newName .. '"', 'success')
  if isLoaded(name, src) then loadCourse(newName, 'mine') else sendList() end
end

-- copy any course (server / legacy / mine) into your own folder
function M.copyCourse(name, source)
  name = safeName(name)
  local dir, src = findCourse(name, source)
  if not dir then toast('Course not found: ' .. name, 'warning'); return end
  local pts, wpts, cdata = readCourseFiles(dir, name)
  local tmp = buildCourse(name, pts, wpts)
  local newName = uniqueName(src == 'mine' and (name .. '_copy') or name)
  if saveCourseFiles(myDir(), newName, tmp.pts, tmp.wpts, cdata.author) then
    toast('Saved a copy as "' .. newName .. '"', 'success')
    if isLoaded(name, src) then loadCourse(newName, 'mine') else sendList() end
  else
    toast('Could not save a copy', 'error')
  end
end

-- auto pacenotes: corners (and crests) read from the course line with BeamNG's own corner sizes; replaces earlier
-- auto pacenotes, keeps the ones you marked yourself
local function rewritePacenotes(name, source, notes)
  name = safeName(name)
  local dir, src = findCourse(name, source)
  if not dir then toast('Course not found: ' .. name, 'warning'); return end
  if src == 'server' or src == 'rally' then toast('This course is read-only - save a copy first', 'warning'); return end
  local pts, wpts = readCourseFiles(dir, name)
  local c = buildCourse(name, pts, wpts)
  if notes == true then
    if not c.hasLine then toast('This course has no course line to read corners from', 'warning'); return end
    notes = PN.generate(c.pts)
  end
  local raw, kept, removed = {}, 0, 0
  for _, w in ipairs(wptsForFile(c.wpts)) do
    if w.icon == PNK.ICON and w.auto then removed = removed + 1
    else
      raw[#raw + 1] = w
      if w.icon == PNK.ICON then kept = kept + 1 end
    end
  end
  for _, nt in ipairs(notes or {}) do
    raw[#raw + 1] = { x = r2(nt.x), y = r2(nt.y), z = r2(nt.z or 0), icon = PNK.ICON, label = '', s = r2(nt.s), pn = nt.pn, auto = true }
  end
  if not writeJson(wptPath(dir, name), raw, true) then toast('Could not save ' .. wptPath(dir, name):sub(2), 'error'); return end
  if isLoaded(name, src) then
    local keepRace = race
    loadCourse(name, src)
    race = keepRace
  else
    sendList()
  end
  return #(notes or {}), kept, removed
end

function M.generatePacenotes(name, source)
  if PNK.ed() == 'chase' then toast('The Chase Edition has no pacenotes', 'warning'); return end
  if not PN then toast('Pacenotes need BeamNG 0.39 or newer', 'warning'); return end
  local added, kept = rewritePacenotes(name, source, true)
  if added then
    toast(string.format('%d pacenotes written from the course line%s', added, kept > 0 and (' (your ' .. kept .. ' kept)') or ''), 'success')
  end
end

function M.clearAutoPacenotes(name, source)
  if not PN then return end
  local _, kept, removed = rewritePacenotes(name, source, {})
  if removed then toast(string.format('Removed %d auto pacenotes%s', removed, kept > 0 and (' (your ' .. kept .. ' kept)') or ''), 'info') end
end

function M.exportGpx(name, source)
  name = safeName(name)
  local dir, src = findCourse(name, source)
  if not dir then toast('Course not found: ' .. name, 'warning'); return end
  local pts, wpts = readCourseFiles(dir, name)
  local tmp = buildCourse(name, pts, wpts)
  local path = GPXDIR .. '/' .. levelId() .. '/' .. name .. '.gpx'
  if writeText(path, buildGpx(name, tmp.pts, tmp.sorted, levelId())) then
    toast('Exported ' .. path:sub(2), 'success')
    Snap.make(name, tmp, GPXDIR .. '/' .. levelId())
  else
    toast('GPX export failed', 'error')
  end
  sendList()
end

function M.importGpx(file)
  file = tostring(file or '')
  if not file:match('^[%w%-_ %.]+/?[%w%-_ %.]*%.[gG][pP][xX]$') or file:find('%.%.') then toast('Bad GPX file name', 'warning'); return end
  local text = readText(GPXDIR .. '/' .. file)
  if not text then toast('Could not read ' .. file, 'error'); return end
  local gname, pts, wpts = parseGpx(text, levelId())
  if not pts or (#pts < 2 and #(wpts or {}) == 0) then toast('No track or waypoints in ' .. file, 'warning'); return end
  local base = safeName(gname or file:match('([^/]+)%.[gG][pP][xX]$') or 'imported')
  if base == '' then base = 'imported' end
  local name = uniqueName(base)
  local tmp = buildCourse(name, pts, wpts)
  if saveCourseFiles(myDir(), name, tmp.pts, tmp.wpts) then
    toast('Imported "' .. name .. '" (' .. #tmp.pts .. ' points, ' .. #tmp.wpts .. ' waypoints)', 'success')
    loadCourse(name, 'mine')
  else
    toast('Import failed', 'error')
  end
end

local SERVER_PACK_README = table.concat({
  'Baja75 Navigation Unit - server pack',
  '==========================',
  '',
  'Race with friends without all the extra HUD: everyone on your BeamMP server gets these courses under',
  'MENU > Courses > Server courses, and can run them by map guidance and markers alone (course line, VCPs,',
  'speed zones, pits) - or race them against the clock with "Race This Route".',
  '',
  'What is in here',
  '  settings/TreadXLGPS/server/<map>/<name>.json and .wpt.json   the courses (added with the GPS "Server pack" button)',
  '  settings/TreadXLGPS/server/<map>/<name>.notes.txt            notes racers see when they pick the course:',
  '                                                               start location, rules, class, install notes',
  '  settings/TreadXLGPS/server/<map>/<name>.png or .jpg          a picture shown with the course (optional)',
  '',
  'Install on your own (self-hosted) BeamMP server',
  '  1. Zip the "settings" folder that is next to this file. The zip must have "settings" at its root.',
  '  2. Put the zip in the server\'s Resources/Client folder, together with the Baja75 Navigation Unit mod zip.',
  '  3. Restart the server. Everyone who joins downloads both.',
  '',
  'Quick share without a server',
  '  Send the zip (or just the .json, .wpt.json, .notes.txt and picture files). The other player puts the files',
  '  in their own BeamNG user folder under settings/TreadXLGPS/<map>/ and finds the course under My courses.',
  '',
}, '\n')

-- elevation of a course line: lowest, highest, climb and descent (1 m steps, so recording noise doesn't add up)
function Snap.elevation(pts)
  local lo, hi, up, down, last, any = nil, nil, 0, 0, nil, false
  for _, p in ipairs(pts or {}) do
    local z = tonumber(p.z)
    if z then
      if z ~= 0 then any = true end
      lo = lo and math.min(lo, z) or z
      hi = hi and math.max(hi, z) or z
      if not last then last = z
      elseif z - last >= 1 then up = up + z - last; last = z
      elseif last - z >= 1 then down = down + last - z; last = z end
    end
  end
  if not any then return nil end
  return { lo = lo, hi = hi, up = up, down = down }
end

-- "Johnson Valley (johnson_valley)"
function Snap.mapName()
  local id = levelId()
  local pretty = (id:gsub('_', ' '):gsub('(%a)(%w*)', function(a, b) return a:upper() .. b end))
  return pretty .. ' (' .. id .. ')'
end

-- the info text: course name, map, distance in miles and kilometres, elevation change
function Snap.info(name, c)
  local e = Snap.elevation(c.pts)
  local function mf(m) return string.format('%d m / %d ft', floor(m + 0.5), floor(m * 3.28084 + 0.5)) end
  local elev = e and (mf(e.hi - e.lo) .. ' (lowest ' .. mf(e.lo) .. ', highest ' .. mf(e.hi) .. '; climb ' .. mf(e.up) .. ', descent ' .. mf(e.down) .. ')')
    or '- (this course has no elevation data)'
  return {
    'Course: ' .. (name:gsub('_', ' ')),
    'Map: ' .. Snap.mapName(),
    string.format('Distance: %.2f mi / %.2f km', (c.length or 0) / 1609.344, (c.length or 0) / 1000),
    'Elevation change: ' .. elev,
  }
end

-- write the info text now and ask the GPS app for the picture (it answers with TreadXLGPS.snapChunk)
function Snap.make(name, c, dir)
  local lines = Snap.info(name, c)
  writeText(dir .. '/' .. name .. '.info.txt', table.concat(lines, '\n') .. '\n')
  if not c.hasLine and #c.wpts == 0 then return end
  Snap.seq = Snap.seq + 1
  local id = 'snap' .. Snap.seq
  Snap.jobs[id] = { path = dir .. '/' .. name .. '.map.jpg', parts = {}, got = 0, t = clock }
  local e = Snap.elevation(c.pts)
  trigger('snapshot', {
    id = id, name = name, title = (name:gsub('_', ' ')), info = lines, level = levelId(), mapName = Snap.mapName(),
    length = r2(c.length or 0), elev = e and { lo = r2(e.lo), hi = r2(e.hi), up = r2(e.up), down = r2(e.down) } or nil,
    flat = flatPts(c.pts), wpts = wptsForUi(c.sorted), mapTiles = terrainTiles(true), satTile = Snap.heightmapTile(),
  })
end

-- base64 -> bytes: the game's own decoder (luasocket mime), else plain Lua
function Snap.unb64(s)
  local okM, mime = pcall(require, 'mime')
  if okM and type(mime) == 'table' and mime.unb64 then
    local ok, out = pcall(mime.unb64, s)
    if ok and type(out) == 'string' and #out > 0 then return out end
  end
  local val, abc = {}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for k = 1, 64 do val[abc:byte(k)] = k - 1 end
  local out, buf, acc, bits = {}, {}, 0, 0
  local char = string.char
  for k = 1, #s do
    local v = val[s:byte(k)]
    if v then
      acc, bits = acc * 64 + v, bits + 6
      if bits >= 8 then
        bits = bits - 8
        local byte = floor(acc / 2 ^ bits)
        acc = acc - byte * 2 ^ bits
        buf[#buf + 1] = byte
        if #buf >= 4096 then out[#out + 1] = char(unpack(buf)); buf = {} end
      end
    end
  end
  if #buf > 0 then out[#out + 1] = char(unpack(buf)) end
  return table.concat(out)
end

function Snap.writeBinary(p, data)
  ensureDir(p:match('^(.*)/[^/]+$') or '/')
  local ok = pcall(function()
    local f = io.open(p, 'wb')
    if not f then error('cannot open') end
    f:write(data)
    f:close()
  end)
  if ok and fileExists(p) then return true end
  return writeText(p, data)
end

-- no answer from the GPS app (not on screen?)
function Snap.tick()
  for id, j in pairs(Snap.jobs) do
    if clock - j.t > Snap.TIMEOUT then
      Snap.jobs[id] = nil
      toast('No map picture for ' .. j.path:match('([^/]+)%.map%.jpg$') .. ' - keep the GPS app on screen while exporting', 'warning')
    end
  end
end

-- copy a course into TreadXLGPS/serverpack/TreadXLGPS/server/<map>/ ; zip the serverpack folder's contents and
-- put the zip in the BeamMP server's Resources/Client: every racer then sees it under "Server courses"
function M.addToServerPack(name, source)
  name = safeName(name)
  local dir = findCourse(name, source)
  if not dir then toast('Course not found: ' .. name, 'warning'); return end
  local pts, wpts, cdata = readCourseFiles(dir, name)
  local tmp = buildCourse(name, pts, wpts)
  local dest = PACK .. SERVER .. '/' .. levelId()
  if not saveCourseFiles(dest, name, tmp.pts, tmp.wpts, cdata.author) then toast('Could not write the server pack', 'error'); return end
  -- notes and picture travel with the course; a notes file is started for you if the course has none
  local notes = readText(dir .. '/' .. name .. '.notes.txt')
  local notesDst = dest .. '/' .. name .. '.notes.txt'
  if notes then writeText(notesDst, notes) elseif not fileExists(notesDst) then writeText(notesDst, notesTemplate(name, tmp)) end
  local pic = findPicture(dir, name, true)
  if pic then pcall(function() FS:copyFile(pic, dest .. '/' .. name .. pic:match('%.%w+$')) end) end
  Snap.make(name, tmp, dest)
  local readme = PACK .. '/README - Baja75 Navigation Unit server pack.txt'
  if not fileExists(readme) then writeText(readme, SERVER_PACK_README) end
  toast('Added "' .. name .. '" to the server pack (notes, course info and map picture)', 'success')
end

-- the course map picture from the GPS app, in base64 pieces
function M.snapChunk(id, i, n, data)
  id, i, n = tostring(id), tonumber(i), tonumber(n)
  local j = Snap.jobs[id]
  if not j or not i or not n or n < 1 or n > 1000 or i < 1 or i > n or type(data) ~= 'string' then return end
  if data:find('[^%w%+/=]') then Snap.jobs[id] = nil; toast('Map picture: bad data from the GPS app', 'error'); return end
  if not j.parts[i] then j.parts[i] = data; j.got = j.got + 1 end
  j.t = clock
  if j.got < n then return end
  Snap.jobs[id] = nil
  local b64 = table.concat(j.parts)
  if #b64 > Snap.MAX then toast('Map picture too large', 'error'); return end
  local bin = Snap.unb64(b64)
  if type(bin) ~= 'string' or bin:sub(1, 3) ~= '\255\216\255' then toast('Map picture: not a JPEG', 'error'); return end
  if Snap.writeBinary(j.path, bin) then
    toast(string.format('Map picture saved: %s (%d KB)', j.path:sub(2), floor(#bin / 1024 + 0.5)), 'success')
  else
    toast('Could not save ' .. j.path:sub(2), 'error')
  end
end

function M.snapFailed(id, why)
  id = tostring(id)
  if not Snap.jobs[id] then return end
  Snap.jobs[id] = nil
  toast('No map picture: ' .. safeLabel(why or 'the GPS app could not draw it'), 'warning')
end

function M.openFolder(kind)
  if kind == 'screenshots' then -- the Onyx Edition's Gallery: BeamNG's screenshots folder
    if openFolder('/screenshots') then toast('Opening your screenshots', 'info') else toast('Your screenshots are in the BeamNG user folder: screenshots', 'info') end
    return
  end
  local dir = kind == 'gpx' and (GPXDIR .. '/' .. levelId()) or kind == 'pack' and PACK or kind == 'log' and USER_ROOT
    or kind == 'music' and USER_ROOT .. '/music' or kind == 'videos' and USER_ROOT .. '/videos' or myDir()
  if openFolder(dir) then toast('Opening ' .. dir:sub(2), 'info')
  else toast('Open this folder in your BeamNG user folder: ' .. dir:sub(2), 'info') end
  log_('I', 'folder: ' .. dir)
end

-- base map (roads + terrain) for the current level; the UI asks until it has one
function M.requestBaseMap(attempt)
  sendBaseMap((tonumber(attempt) or 1) > 1 and baseMapCache.data == nil)
end

function M.startRecording(name) startRecording(name) end
function M.stopRecording(discard) stopRecording(discard) end
function M.markWaypoint(opts) markWaypoint(opts) end
function M.deleteWaypoint(id) deleteWaypoint(id) end

function M.setMarkDefaults(opts)
  if type(opts) ~= 'table' then return end
  markDefaults.icon = safeIcon(opts.icon)
  markDefaults.label = safeLabel(opts.label or '')
  local lim = tonumber(opts.limitMph)
  if lim and lim >= 5 and lim <= 200 then markDefaults.limitMph = lim end
  if opts.pn ~= nil and PN then markDefaults.pn = PN.normalize(opts.pn) end
end

-- ------------------------------------------------------------------ rally pacenotes (API for the UI)
local function sendPacenoteInfo()
  if not PN then trigger('pacenoteInfo', { available = false }); return end
  local voices = {}
  for _, v in ipairs(PN.voices()) do voices[#voices + 1] = { id = v.id, label = v.label } end
  if not PN.voice() then PN.setVoice(pnOpts.voice) end
  local cur = PN.voice()
  trigger('pacenoteInfo', { available = true, catalog = PN.catalog(), voices = voices, voice = cur and cur.id or nil,
    opts = { calls = pnOpts.calls, lead = pnOpts.lead, native = pnOpts.native }, offCourse = offCourseAlert })
end

function M.requestPacenoteInfo() sendPacenoteInfo() end

-- calls: 'on' | 'off' | 'race' (only while racing); lead: 'early' | 'normal' | 'late'; voice: voicepack id; native: send
-- tiles to BeamNG's own pacenote display too
function M.setPacenoteOptions(o)
  if type(o) ~= 'table' then return end
  if o.calls == 'on' or o.calls == 'off' or o.calls == 'race' then pnOpts.calls = o.calls end
  if PNK.LEAD[o.lead] then pnOpts.lead = o.lead end
  if o.native ~= nil then pnOpts.native = o.native == true; if not pnOpts.native then PNC.pnClearNative() end end
  if type(o.voice) == 'string' and o.voice ~= '' then pnOpts.voice = o.voice end
  if o.style == 'chase' or o.style == 'full' then pnOpts.style = o.style end
  if PN then PN.setVoice(pnOpts.voice) end
  if pnOpts.calls == 'off' and PN then PN.clear() end
end

-- the OFF COURSE warning distance in metres (Display)
function M.setOffCourseAlert(m)
  m = tonumber(m)
  if m and m >= 5 and m <= 200 then offCourseAlert = m end
end

-- what a pacenote from the builder looks like (tiles + text), straight from the game's style
function M.pacenotePreview(pn)
  if not PN then return end
  local n = PN.normalize(pn)
  trigger('pacenotePreview', { vis = n and PN.visual(n) or {}, text = n and PN.text(n) or '', ok = n ~= nil })
end

-- hear a pacenote from the builder
function M.previewPacenote(pn)
  if not PN then return end
  if not PN.voice() then PN.setVoice(pnOpts.voice) end
  local n = PN.normalize(pn)
  if not n then toast('Pick a corner or an extra first', 'warning'); return end
  if not PN.voice() then toast('No BeamNG co-driver voice found in this game version', 'warning'); return end
  PN.clear()
  PN.enqueue(pnOpts.style == 'chase' and PN.chasePhrases and PN.chasePhrases(n) or PN.phrases(n))
end

function M.requestChaseTargets() sendChaseTargets() end
function M.setChaseTarget(id) setChaseTarget(id) end
function M.setChaseInterval(sec)
  sec = tonumber(sec) or 0
  if sec < 0 then sec = 0 elseif sec > 600 then sec = 600 end
  chase.interval = sec
  chase.snapT = -1e9
end

function M.resetTrip() trip, maxSpeed = 0, 0 end

function M.listWptIcons()
  local icons = {}
  if FS then
    local ok, files = pcall(function() return FS:findFiles(ICON_BASE, '*.svg', 0, true, false) end)
    if not ok or type(files) ~= 'table' or #files == 0 then
      ok, files = pcall(function() return FS:directoryList(ICON_BASE, false, false) end)
    end
    if ok and type(files) == 'table' then
      for _, f in ipairs(files) do
        local n = tostring(f):match('([^/\\]+%.svg)$')
        if n then icons[#icons + 1] = n end
      end
    end
  end
  table.sort(icons)
  local kinds = {}
  for _, n in ipairs(icons) do kinds[n] = kindOf(n) end
  trigger('icons', { base = ICON_BASE, icons = icons, kinds = kinds })
end

-- ------------------------------------------------------------------ typing fallback: a small game-drawn (ImGui) window
-- for when the HUD app's text boxes can't get the keyboard. The text goes back to the UI as TreadXLGPS.text.
local prompt = nil

function M.promptText(kind, title, initial)
  kind = tostring(kind or '')
  if not kind:match('^[%w_:|%-]+$') then return end
  local ok, im = pcall(function() return ui_imgui end)
  if not ok or not im then toast('Typing window not available in this game version', 'warning'); return end
  -- a web link (the video player's box) gets a long box; names stay short
  local long = kind == 'videoUrl' or kind == 'videoPage'
  local size = long and 512 or 64
  local start = long and trim(tostring(initial or ''):gsub('%c', '')):sub(1, 500) or safeLabel(initial or ''):sub(1, 48)
  local okB, buf = pcall(function() return im.ArrayChar(size, start) end)
  if not okB then okB, buf = pcall(function() return im.ArrayChar(size) end) end
  if not okB then toast('Typing window not available', 'warning'); return end
  prompt = { kind = kind, title = safeLabel(title or 'Name'), buf = buf, open = im.BoolPtr(true), focus = 3, size = size, long = long }
end

local function promptString(buf)
  local ok, t = pcall(function() return ffi.string(buf) end)
  if not ok or type(t) ~= 'string' then ok, t = pcall(tostring, buf) end
  if not ok or type(t) ~= 'string' then return '' end
  return (t:match('^[^%z]*'))
end

local function drawPrompt()
  if not prompt then return end
  local im = ui_imgui
  local done, cancel = false, false
  local ok, err = pcall(function()
    if prompt.focus > 0 then
      pcall(function()
        local c = im.GetMainViewport():GetCenter()
        im.SetNextWindowPos(c, im.Cond_Appearing, im.ImVec2(0.5, 0.5))
      end)
      im.SetNextWindowFocus()
    end
    im.SetNextWindowSize(im.ImVec2(prompt.long and 560 or 380, 0), im.Cond_Appearing)
    local flags = (im.WindowFlags_NoCollapse or 0) + (im.WindowFlags_AlwaysAutoResize or 0)
    if im.Begin('Baja75 Navigation Unit - ' .. prompt.title .. '##txlprompt', prompt.open, flags) then
      im.Text(prompt.long and 'Type or paste (Ctrl+V) the link, then press Enter or OK' or 'Type the name, then press Enter or OK')
      if prompt.focus > 0 then im.SetKeyboardFocusHere(0); prompt.focus = prompt.focus - 1 end
      im.PushItemWidth(prompt.long and 520 or 340)
      if im.InputText('##txltext', prompt.buf, prompt.size or 64, im.InputTextFlags_EnterReturnsTrue) then done = true end
      im.PopItemWidth()
      if im.Button('OK') then done = true end
      im.SameLine()
      if im.Button('Cancel') then cancel = true end
    end
    im.End()
    if prompt.open[0] == false then cancel = true end
  end)
  if not ok then
    log_('E', 'typing window: ' .. tostring(err))
    toast('Typing window failed - see the console (~)', 'error')
    prompt = nil
    return
  end
  if done then
    local typed = promptString(prompt.buf)
    trigger('text', { kind = prompt.kind, text = prompt.long and trim((typed:gsub('%c', ''))):sub(1, 500) or safeLabel(typed) })
    prompt = nil
  elseif cancel then
    prompt = nil
  end
end



-- ------------------------------------------------------------------ media: music + videos folders, clipboard, browser
-- settings/TreadXLGPS/music/ and settings/TreadXLGPS/videos/ are made when the GPS starts; drop files in and the GPS
-- plays them (BeamNG's UI browser plays MP3 / OGG / Opus / FLAC / WAV audio and WebM video, not MP4 / H.264).
-- (a do-block: the main chunk is at Lua's 200-local limit)
do
local MEDIA = {
  MUSIC = USER_ROOT .. '/music', VIDEOS = USER_ROOT .. '/videos', MAX = 3000,
  AUDIO = { mp3 = true, ogg = true, oga = true, opus = true, flac = true, wav = true, webm = true, m4a = 'maybe', aac = 'maybe' },
  VIDEO = { webm = true, ogv = true, mp4 = 'maybe', m4v = 'maybe' },
  README = {
    music = 'Baja75 Navigation Unit - music folder\n\nDrop your music here (sub-folders are fine): MP3, OGG, Opus, FLAC or WAV.\nThen open the GPS, press DISPLAY until the music player shows, and press Rescan.\nM4A / AAC files may not play: BeamNG\'s UI browser has no AAC decoder.\n',
    videos = 'Baja75 Navigation Unit - videos folder\n\nDrop videos here as WebM (VP8 / VP9 video, Opus / Vorbis audio). They play on the GPS screen,\nfull screen or in split screen. MP4 (H.264) files do not play in BeamNG\'s UI browser: convert them to\nWebM first (e.g. with HandBrake or ffmpeg: ffmpeg -i in.mp4 -c:v libvpx-vp9 -c:a libopus out.webm).\n',
  },
}

function MEDIA.ensure()
  for kind, dir in pairs({ music = MEDIA.MUSIC, videos = MEDIA.VIDEOS }) do
    ensureDir(dir)
    local readme = dir .. '/_README.txt'
    if not fileExists(readme) then writeText(readme, MEDIA.README[kind]) end
  end
end

-- every playable file under dir (sub-folders too): { name, file (path below dir), path (for the UI), ext, maybe }
function MEDIA.list(dir, exts)
  local out, seen = {}, {}
  local function add(f)
    f = tostring(f):gsub('\\', '/')
    local rel = f:match('^.-' .. dir:gsub('%p', '%%%0') .. '/(.+)$') or f:match('([^/]+)$')
    local ext = rel and rel:match('%.([%w]+)$')
    ext = ext and ext:lower()
    if rel and ext and exts[ext] and not seen[rel:lower()] and #out < MEDIA.MAX then
      seen[rel:lower()] = true
      out[#out + 1] = { name = rel:match('([^/]+)%.[%w]+$') or rel, file = rel, path = dir .. '/' .. rel, ext = ext, maybe = exts[ext] == 'maybe' or nil }
    end
  end
  local ok, files = pcall(function() return FS:findFiles(dir .. '/', '*', -1, true, false) end)
  if ok and type(files) == 'table' then for _, f in ipairs(files) do add(f) end end
  for _, f in ipairs(listFiles(dir, '.')) do add(dir .. '/' .. f) end
  table.sort(out, function(a, b) return a.file:lower() < b.file:lower() end)
  return out
end

function M.requestMedia()
  MEDIA.ensure()
  trigger('media', {
    music = MEDIA.list(MEDIA.MUSIC, MEDIA.AUDIO), videos = MEDIA.list(MEDIA.VIDEOS, MEDIA.VIDEO),
    paths = { music = MEDIA.MUSIC:sub(2), videos = MEDIA.VIDEOS:sub(2) },
    real = { music = realPath(MEDIA.MUSIC), videos = realPath(MEDIA.VIDEOS) },
  })
end

-- the PASTE button: the text on the computer's clipboard
function M.readClipboard()
  local ok, txt = pcall(function() return getClipboard and getClipboard() end)
  txt = ok and type(txt) == 'string' and txt or ''
  trigger('clipboard', { text = trim(txt):sub(1, 2000), ok = ok and getClipboard ~= nil or nil })
end

-- open a web link in the Steam overlay / the computer's browser (the game may refuse some sites)
function M.openLink(url)
  url = trim(tostring(url or ''))
  if not url:match('^https?://[%w%-%.]+%.[%a][%a]+[/%?#]?') or url:find('[%s"\'<>]') or #url > 2000 then
    toast('That is not a web link', 'warning'); return
  end
  if type(openWebBrowser) ~= 'function' then toast('This game version cannot open web pages', 'warning'); return end
  local ok, err = pcall(openWebBrowser, url)
  if ok then toast('Opening in your browser (Steam overlay: Shift+Tab)', 'info')
  else toast('The game would not open that page', 'warning'); log_('W', 'openWebBrowser: ' .. tostring(err)) end
end

M.ensureMediaFolders = MEDIA.ensure
end

-- ------------------------------------------------------------------ album art for the music player
-- A song's cover: a picture with the song's name (Song.jpg), the picture inside the file (MP3 ID3 APIC, FLAC
-- PICTURE, OGG / Opus METADATA_BLOCK_PICTURE, M4A covr), or the folder's cover.jpg / folder.jpg / front.jpg.
-- Pictures taken out of a file are kept in settings/TreadXLGPS/cache/art/ so the GPS can show them.
-- (a do-block: the main chunk is at Lua's 200-local limit)
do
local ART = { DIR = USER_ROOT .. '/cache/art', MUSIC = USER_ROOT .. '/music/', MAX = 32 * 1024 * 1024,
  NAMES = { 'cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'artwork' }, EXTS = { 'jpg', 'jpeg', 'png', 'webp' } }

-- (helpers live in the table: only one new local fits next to the main chunk's 199)
function ART.u32be(s, i) local a, b, c, d = s:byte(i, i + 3); if not d then return nil end return ((a * 256 + b) * 256 + c) * 256 + d end
function ART.u32le(s, i) local a, b, c, d = s:byte(i, i + 3); if not d then return nil end return ((d * 256 + c) * 256 + b) * 256 + a end
function ART.syncsafe(s, i) local a, b, c, d = s:byte(i, i + 3); if not d then return nil end return ((a * 128 + b) * 128 + c) * 128 + d end

-- what kind of picture the bytes are (nil = not a picture we can show)
function ART.kind(img)
  if type(img) ~= 'string' or #img < 64 then return nil end
  if img:sub(1, 3) == '\255\216\255' then return 'jpg' end
  if img:sub(1, 8) == '\137PNG\r\n\26\n' then return 'png' end
  if img:sub(1, 4) == 'RIFF' and img:sub(9, 12) == 'WEBP' then return 'webp' end
  if img:sub(1, 4) == 'GIF8' then return 'gif' end
  return nil
end

function ART.read(p, n)
  local data
  pcall(function()
    local f = io.open(p, 'rb')
    if f then data = f:read(n or ART.MAX); f:close() end
  end)
  if not data and readFile then local ok, d = pcall(readFile, p); if ok and type(d) == 'string' then data = d:sub(1, n or ART.MAX) end end
  return data
end

-- FLAC / Vorbis picture block: type, mime, description, size, colours, then the picture
function ART.pictureBlock(b)
  local i = 5
  local ml = ART.u32be(b, i); if not ml then return nil end
  i = i + 4 + ml
  local dl = ART.u32be(b, i); if not dl then return nil end
  i = i + 4 + dl + 16
  local len = ART.u32be(b, i); if not len then return nil end
  return b:sub(i + 4, i + 3 + len), ART.u32be(b, 1)
end

-- MP3: the ID3v2 tag's APIC (v2.3 / v2.4) or PIC (v2.2) frame; the front cover (type 3) if there are several
function ART.id3(d)
  if d:sub(1, 3) ~= 'ID3' then return nil end
  local ver, flags, size = d:byte(4), d:byte(6), ART.syncsafe(d, 7)
  if not size or ver < 2 or ver > 4 then return nil end
  local tag, i, best, bestType = d:sub(11, 10 + size), 1, nil, nil
  if flags and flags % 128 >= 64 and ver >= 3 then i = i + 4 + (ver == 4 and ART.syncsafe(tag, 1) or ART.u32be(tag, 1) or 0) end -- extended header
  while i + 10 <= #tag do
    local id, fsize, hdr
    if ver == 2 then
      id, hdr = tag:sub(i, i + 2), 6
      local a, b, c = tag:byte(i + 3, i + 5); fsize = (a or 0) * 65536 + (b or 0) * 256 + (c or 0)
    else
      id, hdr = tag:sub(i, i + 3), 10
      fsize = ver == 4 and ART.syncsafe(tag, i + 4) or ART.u32be(tag, i + 4)
    end
    if not fsize or fsize <= 0 or id:byte(1) == 0 then break end
    local f = tag:sub(i + hdr, i + hdr + fsize - 1)
    if id == 'APIC' or id == 'PIC' then
      local enc, j = f:byte(1), 2
      if id == 'APIC' then j = (f:find('\0', 2, true) or #f) + 1 else j = 5 end -- MIME text, or the 3-letter format
      local ptype = f:byte(j); j = j + 1
      if enc == 1 or enc == 2 then -- UTF-16 description: ends with two zero bytes on an even boundary
        while j < #f and not (f:byte(j) == 0 and f:byte(j + 1) == 0) do j = j + 2 end
        j = j + 2
      else
        j = (f:find('\0', j, true) or #f) + 1
      end
      local img = f:sub(j)
      if ART.kind(img) and (not best or (ptype == 3 and bestType ~= 3)) then best, bestType = img, ptype end
    end
    i = i + hdr + fsize
  end
  return best
end

function ART.flac(d)
  if d:sub(1, 4) ~= 'fLaC' then return nil end
  local i = 5
  while i + 4 <= #d do
    local h = d:byte(i)
    local a, b, c = d:byte(i + 1, i + 3)
    local len = (a or 0) * 65536 + (b or 0) * 256 + (c or 0)
    if h % 128 == 6 then local img = ART.pictureBlock(d:sub(i + 4, i + 3 + len)); if ART.kind(img) then return img end end
    if h >= 128 then break end -- last metadata block
    i = i + 4 + len
  end
  return nil
end

-- OGG / Opus: the second packet (Vorbis comments / OpusTags), put together from its pages
function ART.ogg(d)
  if d:sub(1, 4) ~= 'OggS' then return nil end
  local i, packets, cur = 1, 0, {}
  while i + 27 <= #d and packets < 2 do
    if d:sub(i, i + 3) ~= 'OggS' then return nil end
    local nseg = d:byte(i + 26)
    local p = i + 27 + nseg
    for k = 1, nseg do
      local l = d:byte(i + 26 + k)
      cur[#cur + 1] = d:sub(p, p + l - 1)
      p = p + l
      if l < 255 then
        packets = packets + 1
        if packets == 2 then break end
        cur = {}
      end
    end
    i = p
  end
  local pk = table.concat(cur)
  local j = pk:sub(1, 7) == '\3vorbis' and 8 or pk:sub(1, 8) == 'OpusTags' and 9 or nil
  if not j then return nil end
  local vl = ART.u32le(pk, j); if not vl then return nil end
  j = j + 4 + vl
  local n = ART.u32le(pk, j) or 0
  j = j + 4
  for _ = 1, math.min(n, 500) do
    local cl = ART.u32le(pk, j); if not cl then break end
    local c = pk:sub(j + 4, j + 3 + cl)
    j = j + 4 + cl
    local key, val = c:match('^([^=]+)=(.*)$')
    key = key and key:upper()
    if key == 'METADATA_BLOCK_PICTURE' or key == 'COVERART' then
      local raw = Snap.unb64(val)
      local img = key == 'COVERART' and raw or (raw and ART.pictureBlock(raw))
      if ART.kind(img) then return img end
    end
  end
  return nil
end

-- M4A: the 'covr' atom's 'data' atom
function ART.m4a(d)
  local i = d:find('covr', 1, true)
  if not i then return nil end
  local len = ART.u32be(d, i + 4)
  if not len or d:sub(i + 8, i + 11) ~= 'data' then return nil end
  local img = d:sub(i + 20, i + 3 + len)
  return ART.kind(img) and img or nil
end

function ART.key(p)
  local h1, h2 = 5381, 0
  for k = 1, #p do local b = p:byte(k); h1 = (h1 * 33 + b) % 4294967296; h2 = (h2 * 31 + b * k) % 2147483647 end
  return string.format('%08x%08x', h1, h2)
end

-- the picture to show for one song (a /settings/... path), or nil
function ART.find(p)
  local base, dir = p:match('^(.*)%.[%w]+$'), p:match('^(.*)/[^/]+$')
  if not base or not dir then return nil end
  for _, e in ipairs(ART.EXTS) do if fileExists(base .. '.' .. e) then return base .. '.' .. e end end
  local key = ART.key(p)
  for _, e in ipairs({ 'jpg', 'png', 'webp', 'gif' }) do
    local c = ART.DIR .. '/' .. key .. '.' .. e
    if fileExists(c) then return c end
  end
  local ext = (p:match('%.([%w]+)$') or ''):lower()
  local d = ART.read(p, ext == 'mp3' and 10 or 4 * 1024 * 1024)
  local img
  if d and ext == 'mp3' and d:sub(1, 3) == 'ID3' then
    local size = ART.syncsafe(d, 7)
    d = size and ART.read(p, math.min(ART.MAX, size + 10)) or nil
    img = d and ART.id3(d)
  elseif d then
    img = ART.flac(d) or ART.ogg(d) or (ext == 'm4a' or ext == 'aac' or ext == 'mp4') and ART.m4a(d) or nil
  end
  local kind = ART.kind(img)
  if kind then
    local out = ART.DIR .. '/' .. key .. '.' .. kind
    if Snap.writeBinary(out, img) then return out end
  end
  for _, n in ipairs(ART.NAMES) do
    for _, e in ipairs(ART.EXTS) do
      local c = dir .. '/' .. n .. '.' .. e
      if fileExists(c) then return c end
    end
  end
  return nil
end

-- the GPS asks when a song starts: TreadXLGPS.musicArt {path, art}
function M.musicArt(p)
  p = tostring(p or '')
  if p:sub(1, #ART.MUSIC) ~= ART.MUSIC or p:find('..', 1, true) or p:find('[%c"\']') or #p > 600 or not fileExists(p) then return end
  local ok, art = pcall(ART.find, p)
  if not ok then log_('W', 'album art: ' .. tostring(art)); art = nil end
  trigger('musicArt', { path = p, art = art })
end
M._art = ART
end

-- ------------------------------------------------------------------ video: a tiny web page on this computer for YouTube
-- YouTube's player now wants to know which web page it is on (the HTTP Referer). BeamNG's screens are local:// pages that
-- send none, so YouTube answers "Error 153". The fix: the GPS serves one small page at http://localhost:37575/yt.html
-- (this computer only, never the network) that holds YouTube's player, so YouTube sees a normal web page.
-- It only ever hands out that page; nothing else is read or written. It starts the first time you play a YouTube link.
-- (a do-block: the main chunk is at Lua's 200-local limit)
do
local VS = { HOST = '127.0.0.1', PORT = 37575, TRIES = 10, MAX_CLIENTS = 16, TIMEOUT = 5, clients = {} }

VS.PAGE = [==[<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Baja75 Navigation Unit video</title>
<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;color:#bbb;font:14px sans-serif}
iframe{border:0;width:100%;height:100%;display:block}p{margin:0;padding:1em}</style></head>
<body><script>
(function () {
  var q = {};
  location.search.slice(1).split('&').forEach(function (kv) {
    var i = kv.indexOf('='), k = i < 0 ? kv : kv.slice(0, i);
    if (k) { try { q[k] = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1)); } catch (e) { } }
  });
  var id = /^[\w-]{11}$/.test(q.v || '') ? q.v : '', list = /^[\w-]{2,64}$/.test(q.list || '') ? q.list : '';
  var start = /^\d{1,6}$/.test(q.start || '') ? q.start : '';
  var host = q.yt === '1' ? 'https://www.youtube.com' : 'https://www.youtube-nocookie.com';
  function up(o) { try { parent.postMessage(typeof o === 'string' ? o : JSON.stringify(o), '*'); } catch (e) { } }
  if (!id && !list) { document.body.innerHTML = '<p>No video.</p>'; up({ event: 'txlReady', ok: false }); return; }
  var f = document.createElement('iframe');
  f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  f.setAttribute('allowfullscreen', '');
  f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  f.src = host + '/embed/' + (id || 'videoseries') + '?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1' +
    '&origin=' + encodeURIComponent(location.origin) + '&widget_referrer=' + encodeURIComponent(location.origin + '/') +
    (list ? '&list=' + list : '') + (start ? '&start=' + start : '');
  document.body.appendChild(f);
  // the GPS <-> YouTube's player: pass the messages along both ways
  window.addEventListener('message', function (e) {
    if (e.source === f.contentWindow) up(e.data);
    else if (e.source === parent && f.contentWindow) { try { f.contentWindow.postMessage(e.data, '*'); } catch (x) { } }
  });
  up({ event: 'txlReady', ok: true, origin: location.origin, ver: '%VERSION%' });
})();
</script></body></html>
]==]

function VS.lib()
  if VS.socket ~= nil then return VS.socket or nil end
  for _, name in ipairs({ 'socket', 'socket.core', 'libs/luasocket/socket.socket', 'libs/luasocket/socket' }) do
    local ok, mod = pcall(require, name)
    if ok and type(mod) == 'table' and type(mod.tcp) == 'function' then VS.socket = mod; return mod end
  end
  VS.socket = false
  return nil
end

-- listen on 127.0.0.1 (this computer only): port 37575, or the next free one
function VS.start()
  if VS.listener then return VS.port end
  local socket = VS.lib()
  if not socket then VS.err = 'LuaSocket is not available in this game version'; return nil end
  for i = 0, VS.TRIES - 1 do
    local ok, s = pcall(socket.tcp)
    if ok and s then
      local bound = s:bind(VS.HOST, VS.PORT + i)
      if bound and s:listen(16) then
        s:settimeout(0)
        VS.listener, VS.port, VS.err = s, VS.PORT + i, nil
        log_('I', 'video page: http://localhost:' .. VS.port .. '/yt.html')
        return VS.port
      end
      pcall(function() s:close() end)
    end
  end
  VS.err = 'ports ' .. VS.PORT .. '-' .. (VS.PORT + VS.TRIES - 1) .. ' are all in use'
  log_('W', 'video page: ' .. VS.err)
  return nil
end

function VS.stop()
  for _, k in ipairs(VS.clients) do pcall(function() k.s:close() end) end
  VS.clients = {}
  if VS.listener then pcall(function() VS.listener:close() end) end
  VS.listener, VS.port = nil, nil
end

function VS.http(code, ctype, body, headOnly)
  local reason = ({ [200] = 'OK', [400] = 'Bad Request', [403] = 'Forbidden', [404] = 'Not Found', [405] = 'Method Not Allowed' })[code] or 'OK'
  return table.concat({
    'HTTP/1.1 ' .. code .. ' ' .. reason,
    'Content-Type: ' .. ctype,
    'Content-Length: ' .. #body,
    'Cache-Control: no-store',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'X-Content-Type-Options: nosniff',
    'Connection: close',
    '', headOnly and '' or body }, '\r\n')
end

-- one request -> the answer: the video page, a ping, or "not found"
function VS.respond(req)
  local method, target = req:match('^(%u+) (%S+) HTTP/%d')
  if not method then return VS.http(400, 'text/plain', 'bad request') end
  if method ~= 'GET' and method ~= 'HEAD' then return VS.http(405, 'text/plain', 'only GET') end
  local host = (req:match('\r?\n[Hh][Oo][Ss][Tt]:%s*([^\r\n]+)') or ''):lower():gsub('%s+$', '')
  local name = host:match('^%[[^%]]+%]') or host:match('^[^:]+') or ''
  if name ~= 'localhost' and name ~= '127.0.0.1' and name ~= '[::1]' then return VS.http(403, 'text/plain', 'this computer only') end
  local path = target:match('^[^?#]*')
  if path == '/yt.html' then
    VS.served = (VS.served or 0) + 1
    if VS.served <= 3 then log_('I', 'video page: the game\'s screen asked for /yt.html (' .. VS.served .. ')') end
    trigger('videoHit', { n = VS.served })
    return VS.http(200, 'text/html; charset=utf-8', (VS.PAGE:gsub('%%VERSION%%', VERSION)), method == 'HEAD')
  elseif path == '/ping' then
    return VS.http(200, 'text/plain; charset=utf-8', 'TreadXLGPS ' .. VERSION, method == 'HEAD')
  end
  return VS.http(404, 'text/plain', 'not found', method == 'HEAD')
end

-- one connection, a little at a time (nothing here ever waits): read the request, send the answer, close
function VS.step(k)
  if not k.out then
    local data, err, part = k.s:receive(4096)
    local got = data or part
    if got and got ~= '' then k.buf = k.buf .. got end
    if #k.buf > 16384 then return true end
    if k.buf:find('\r\n\r\n', 1, true) or k.buf:find('\n\n', 1, true) then
      k.out, k.sent = VS.respond(k.buf), 0
    elseif err == 'closed' or clock - k.t > VS.TIMEOUT then
      return true
    else
      return false
    end
  end
  local last, err, lastPart = k.s:send(k.out, k.sent + 1)
  k.sent = last or lastPart or k.sent
  if k.sent >= #k.out then pcall(function() k.s:shutdown('send') end); return true end
  return (err and err ~= 'timeout') or clock - k.t > VS.TIMEOUT
end

-- every frame while the page is up (onUpdate)
function VS.poll()
  local l = VS.listener
  if not l then return end
  for _ = 1, 4 do
    local c = l:accept()
    if not c then break end
    c:settimeout(0)
    if #VS.clients >= VS.MAX_CLIENTS then pcall(function() c:close() end)
    else VS.clients[#VS.clients + 1] = { s = c, buf = '', t = clock } end
  end
  for i = #VS.clients, 1, -1 do
    local k = VS.clients[i]
    local ok, done = pcall(VS.step, k)
    if not ok or done then
      pcall(function() k.s:close() end)
      table.remove(VS.clients, i)
    end
  end
end

-- the GPS asks for the page before it plays a YouTube link: { port } or { error }
function M.videoServer()
  local port = VS.start()
  trigger('videoServer', { port = port, error = not port and VS.err or nil })
end

function M.onExtensionUnloaded() VS.stop() end
-- a line from the GPS screen for beamng.log (video page troubleshooting)
function M.uiLog(msg) log_('I', 'UI: ' .. tostring(msg or ''):gsub('[%c]', ' '):sub(1, 3500)) end
M._video = VS
end

-- ------------------------------------------------------------------ Tuner gauges straight from the vehicle
-- rpm, gear, throttle, temperatures, fuel, boost and battery, 4 times a second while one of them is on the screen.
-- (The UI's electrics stream doesn't reach HUD apps in every game version, and it has no battery charge.)
-- (a do-block: the main chunk is at Lua's 200-local limit)
do
local TEL = { on = false, at = -99, EVERY = 0.25,
  NUM = { 'rpm', 'throttle', 'watertemp', 'oiltemp', 'fuel', 'turboBoost', 'running', 'ignition', 'battery', 'checkengine',
    'brake', 'clutch', 'speed', 'maxrpm', 'idlerpm', 'gx', 'gy' } }
TEL.VLUA = [==[
local e = electrics.values or {}
local bat
if energyStorage and energyStorage.getStorages then
  local stored, cap = 0, 0
  for _, s in pairs(energyStorage.getStorages() or {}) do
    if s.type == 'electricBattery' and (tonumber(s.energyCapacity) or 0) > 0 then stored = stored + (tonumber(s.storedEnergy) or 0); cap = cap + s.energyCapacity end
  end
  if cap > 0 then bat = stored / cap end
end
local ei = controller and controller.mainController and controller.mainController.engineInfo or {}
local gx, gy = sensors and sensors.gx2, sensors and sensors.gy2
local d = { rpm = e.rpm, gear = e.gear, throttle = e.throttle, watertemp = e.watertemp, oiltemp = e.oiltemp, fuel = e.fuel,
  turboBoost = e.turboBoost, running = e.engineRunning, ignition = e.ignitionLevel, battery = bat, checkengine = e.checkengine,
  brake = e.brake, clutch = e.clutch, speed = e.wheelspeed or e.airspeed, maxrpm = ei[2], idlerpm = ei[1],
  gx = gx and gx / 9.81, gy = gy and gy / 9.81 }
obj:queueGameEngineLua('if TreadXLGPS and TreadXLGPS.onTelemetry then TreadXLGPS.onTelemetry(' .. obj:getId() .. ', ' .. serialize(d) .. ') end')
]==]

-- the GPS says when a Tuner gauge is on its screen
function M.setTelemetry(on) TEL.on = on == true or on == 1 or on == 'true'; TEL.at = -99 end

-- the vehicle's answer: numbers only (and a short gear name), then on to the screen
function M.onTelemetry(vid, d)
  local pv = playerVehicle()
  local ok, pid = pcall(function() return pv and pv:getID() end)
  if not ok or not pid or tonumber(vid) ~= pid or type(d) ~= 'table' then return end
  local out = {}
  for _, k in ipairs(TEL.NUM) do
    local v = d[k]
    if type(v) == 'boolean' then v = v and 1 or 0 end
    v = tonumber(v)
    if v and v == v and v > -1e9 and v < 1e9 then out[k] = v end
  end
  local g = d.gear
  if type(g) == 'number' and g == g and g > -10 and g < 30 then out.gear = g
  elseif type(g) == 'string' and #g <= 4 and g:match('^[%w%-]+$') then out.gear = g end
  trigger('tel', out)
end

function TEL.tick()
  if not TEL.on or clock - TEL.at < TEL.EVERY then return end
  TEL.at = clock
  local pv = playerVehicle()
  if pv then pcall(function() pv:queueLuaCommand(TEL.VLUA) end) end
end
M._tel = TEL
end

-- ------------------------------------------------------------------ route detection: the players ahead of you on the course
-- Every vehicle someone is driving (BeamMP players; in single player, AI drivers too) that is ON the loaded course line
-- (within the off-course distance) and ahead of you, with how far ahead along the course. Players walking (unicycle),
-- without a vehicle, or off the course give nothing. 5 times a second, the 6 nearest ahead.
-- (a do-block: the main chunk is at Lua's 200-local limit)
do
local FIELD = { tracks = {}, list = nil, t = -1e9, EVERY = 0.2, MAX = 6 }

function FIELD.update()
  if not (course and course.hasLine and progress and me) then FIELD.tracks, FIELD.list = {}, nil; return nil end
  if FIELD.list and clock - FIELD.t < FIELD.EVERY then return FIELD.list end
  local playerId = -1
  local pv = playerVehicle()
  if pv then local ok, id = pcall(function() return pv:getID() end); if ok then playerId = id end end
  local multiplayer = MPVehicleGE ~= nil and MPVehicleGE.getVehicleByGameID ~= nil
  local lim = offCourseAlert
  local out, seen = {}, {}
  local okAll, all = pcall(function() return getAllVehicles and getAllVehicles() or {} end)
  for _, v in ipairs(okAll and type(all) == 'table' and all or {}) do
    local okId, id = pcall(function() return v:getID() end)
    if okId and id and not isMine(id, playerId) then
      local okA, active = pcall(function() return v:getActive() end)
      local info = cachedInfo(id, v)
      -- someone in a vehicle: a BeamMP player's car (any driven car in single player); never props, cones or walking
      if (not okA or active ~= false) and not PROP_JBEAMS[info.model or ''] and (info.mp or not multiplayer) then
        local sv = sampleVehicle(v)
        if sv then
          local tr = FIELD.tracks[id] or {}
          FIELD.tracks[id] = tr
          seen[id] = true
          local off, s = project(course, tr, sv.x, sv.y)
          tr.on = off <= lim or (tr.on == true and off <= lim * 1.25) -- the same off-course distance as yours
          if tr.on and s > progress.s + 1 then
            out[#out + 1] = { id = id, name = info.name, gap = r2(s - progress.s), s = r2(s), speed = r2(sv.speed), mp = info.mp or nil }
          end
        end
      end
    end
  end
  for id in pairs(FIELD.tracks) do if not seen[id] then FIELD.tracks[id] = nil end end
  table.sort(out, function(a, b) return a.gap < b.gap end)
  for i = #out, FIELD.MAX + 1, -1 do out[i] = nil end
  FIELD.list, FIELD.t = out, clock
  return out
end
M._field = FIELD
end

-- input actions (lua/ge/extensions/core/input/actions/TreadXLGPS.json)
-- the five buttons under the screen (1 = MODE, 2 = DISPLAY, 3-5 not used yet) and the media keys
function M.actionButton(n) trigger('cmd', { cmd = 'button', n = tonumber(n) or 0 }) end
function M.actionMedia(what)
  what = tostring(what or '')
  if what:match('^[%a%d]+$') then trigger('cmd', { cmd = 'media', what = what }) end
end
function M.actionMark() markWaypoint({}) end
function M.actionChaseNext() chaseNext() end
function M.actionZoom(dir) trigger('cmd', { cmd = 'zoom', dir = tonumber(dir) or 1 }) end
function M.actionOrientation() trigger('cmd', { cmd = 'orientation' }) end
function M.actionRecord()
  if rec then stopRecording() else startRecording('') end
end

-- ------------------------------------------------------------------ hooks
local function tick()
  local s = sampleVehicle(playerVehicle(), me and me.heading)
  if s then
    if lastPos then
      local d = sqrt((s.x - lastPos.x) ^ 2 + (s.y - lastPos.y) ^ 2)
      if d < MAX_JUMP then trip = trip + d end
    end
    lastPos = { x = s.x, y = s.y }
    if s.speed > maxSpeed and s.speed < 150 then maxSpeed = s.speed end
    if rec then addRecPoint(s.x, s.y, s.z) end
  end
  me = s
  trigger('hud', buildHud())
  Dmg.tick()
  Snap.tick()
  if race then RunLog.hookVehicle(playerVehicle()) end
  M._tel.tick()
end

function M.onUpdate(dtReal, dtSim)
  dtReal = tonumber(dtReal) or 0
  if M._lock then M._lock.check() end -- joined / left a Baja75 server: the screen is told
  clock = clock + dtReal
  raceClock = raceClock + (tonumber(dtSim) or dtReal)
  if PN then PN.update(clock) end
  hudTimer = hudTimer + dtReal
  if hudTimer >= HUD_INTERVAL then
    hudTimer = 0
    local ok, err = pcall(tick)
    if not ok then log_('E', 'tick failed: ' .. tostring(err)) end
  end
  if rec then
    trailTimer = trailTimer + dtReal
    if trailTimer >= TRAIL_INTERVAL then
      trailTimer = 0
      sendTrail(false)
    end
  end
  if prompt then drawPrompt() end
  if M._video.listener then pcall(M._video.poll) end -- the YouTube page (see 'video: a tiny web page')
end

function M.onClientPostStartMission()
  -- new map: courses are per map
  if rec then stopRecording(true) end
  course = nil
  race = nil
  bootPending = true
  resetRun()
  chase.id, chase.name, chase.snap = nil, nil, nil
  lastPos = nil
  sendCourse()
  sendList()
  sendChaseTargets()
  baseMapCache = { level = nil, data = nil }
  trigger('cmd', { cmd = 'mapChanged' })
end

function M.onWorldReadyState(state)
  if state == 2 then -- level fully loaded: the road graph is ready now
    baseMapCache = { level = nil, data = nil }
    trigger('cmd', { cmd = 'mapChanged' })
    sendBaseMap()
  end
end

-- the AI road graph was (re)built, e.g. a moment after the level finished loading
function M.onNavgraphReloaded()
  baseMapCache = { level = nil, data = nil }
  sendBaseMap()
end

function M.onVehicleDestroyed(id)
  if chase.id and id == chase.id then chase.snap = nil end
end

-- resets (the game's vehicle reset, e.g. R / Home) and recoveries (Insert) during a timed run
function M.onVehicleResetted(vid)
  local pv = playerVehicle()
  local ok, pid = pcall(function() return pv and pv:getID() end)
  if not ok or not pid or vid ~= pid then return end
  RunLog.hookedAt = nil -- a reloaded vehicle needs the recovery note again
  if RunLog.recovering and RunLog.recoverAt and clock - RunLog.recoverAt < 30 then return end -- part of a recovery
  if clock < RunLog.quietUntil or (race and race.quietUntil and clock < race.quietUntil) then return end
  if race and race.state == 'running' then log_('I', 'vehicle reset') end
  RunLog.event('reset')
  Dmg.rebaseAt = clock + 1
end

-- recoveries: the game's hooks (once when it starts, once when you let go) and the vehicle's own note (RunLog.VLUA)
function M.onStartRecovering() RunLog.recoverStart('game') end
function M.onStopRecovering() RunLog.recoverStop() end
function M.vehRecovery(vid, what)
  local pv = playerVehicle()
  local ok, pid = pcall(function() return pv and pv:getID() end)
  if not ok or not pid or tonumber(vid) ~= pid then return end
  if what == 'start' then RunLog.recoverStart('vehicle') elseif what == 'stop' then RunLog.recoverStop() end
end

-- damage log: the vehicle's answer (see Dmg.VLUA), and the Display switch
function M.onPartDamage(list, tag) Dmg.receive(list, tag) end
function M.setDamageLog(on)
  Dmg.on = on == true or on == 1
  if not Dmg.on then Dmg.pending = nil end
end

function M.onExtensionLoaded()
  log_('I', 'loaded v' .. VERSION .. ' (level: ' .. levelId() .. ')')
  pcall(M.ensureMediaFolders) -- the music and videos folders exist from the first start
  sendHello(false)
end

function M.onSerialize()
  return { trip = trip, maxSpeed = maxSpeed, course = course and course.name or nil, courseSource = course and course.source or nil,
    chaseInterval = chase.interval, markDefaults = markDefaults, pnOpts = pnOpts, offCourseAlert = offCourseAlert, soundOn = soundOn,
    damageLog = Dmg.on, unlocked = M._lock and M._lock.password or nil,
    adminEnd = M._lock and M._lock.LIC.adminEnd or nil, adminUsed = M._lock and M._lock.LIC.adminUsed or nil,
    login = M._lock and M._lock.LOGIN.on or nil, loginMp = M._lock and M._lock.LOGIN.prevMp or nil,
    driver = RunLog.name, number = RunLog.number }
end

function M.onDeserialized(data)
  if type(data) ~= 'table' then return end
  trip = tonumber(data.trip) or 0
  maxSpeed = tonumber(data.maxSpeed) or 0
  chase.interval = tonumber(data.chaseInterval) or 0
  if type(data.markDefaults) == 'table' then M.setMarkDefaults(data.markDefaults) end
  if type(data.pnOpts) == 'table' then M.setPacenoteOptions(data.pnOpts) end
  if tonumber(data.offCourseAlert) then M.setOffCourseAlert(data.offCourseAlert) end
  if data.soundOn ~= nil then soundOn = data.soundOn == true end
  if data.damageLog ~= nil then Dmg.on = data.damageLog == true end
  if data.unlocked == true and M._lock then M._lock.password = true end -- a Lua reload keeps the password unlock
  if M._lock then M._lock.LIC.adminEnd = tonumber(data.adminEnd); M._lock.LIC.adminUsed = data.adminUsed == true end -- ...and the admin hour (once per game start)
  if type(data.driver) == 'string' then M.setDriver(data.driver, data.number) end -- the driver name / race number (the screen doesn't send them again)
  if M._lock and data.login == true then M._lock.LOGIN.on = true; M._lock.LOGIN.prevMp = data.loginMp == true end -- ...and the sign-in (signed out if that reload was leaving a server)
  if type(data.course) == 'string' then pcall(loadCourse, data.course, data.courseSource) end
end

-- ---------------------------------------------------------------- locked parts off the Baja75 servers (v2.7.06, v2.7.07)
-- Off the Baja75 BeamMP servers, until the password is entered:
--   * recording a course: the full GPS and the Chase and Rally Editions (v2.7.07: the password unlocks it too)
--   * the full GPS also: marking / deleting waypoints, the Chase Map, pacenote writing, GPX and server pack
--     (its screen also locks mode switching, split screen and the Record / Waypoints / Share / Display tabs the same way)
-- A Baja75 server = 199.127.61.187 port 30984 or 30997, or a server whose name has one of the Baja75 names in it
-- (kept as digests, like the password).
-- The BeamMP mod's MPCoreNetwork knows the server: getCurrentServer() = { ip, port, name }, isMPSession().
-- The password unlocks until the game closes (kept over Lua reloads, never written to disk); only its digest is here.
-- The Common Edition has no locks, and no recording, marking, Chase Map, sharing out or video at all (COMMON_OFF). (Inside a function called once: the main chunk is at Lua's 200-local limit.)
do (function()
local LOCK = {
  SERVERS = { '199.127.61.187:30984', '199.127.61.187:30997' },
  NAMES = { { 6, 'e5219330682dc173' }, { 6, '7e690f69b9ab4a88' }, { 9, '61b5de1f53e2165c' }, { 9, '39ffe272dba64485' } }, -- { length, digest }: the server-name words
  nameSeen = {},
  DIGEST = '61b5de1f53e2165c',
  EVERY = 1, t = -1e9, server = nil, at = nil, password = false, dns = {}, allowed = {},
  -- not in the free Common Edition off the Baja75 servers: marking, waypoint / pacenote writing, the Chase Map, sharing out
  COMMON_OFF = { markWaypoint = 1, actionMark = 1, deleteWaypoint = 1, generatePacenotes = 1,
    clearAutoPacenotes = 1, editNotes = 1, setChaseTarget = 1, actionChaseNext = 1, exportGpx = 1, addToServerPack = 1 }, -- (video: yes, v3.1.2)
  -- the servers or the password (what = the locked part, for the password screen)
  NEED = { markWaypoint = 'mark', actionMark = 'mark', deleteWaypoint = 'wpts', setChaseTarget = 'chase', actionChaseNext = 'chase',
    generatePacenotes = 'wpts', clearAutoPacenotes = 'wpts', exportGpx = 'share', addToServerPack = 'share' },
}

-- the server check runs in every edition (on a Baja75 server every edition has every feature); the password is for
-- the full GPS and the Chase and Rally Editions (the Common Edition has none)
function LOCK.applies() return true end
function LOCK.hasPassword() return PNK.EDITION ~= 'common' and PNK.EDITION ~= 'free' end
function LOCK.freeTier() return PNK.EDITION == 'common' or PNK.EDITION == 'free' end

-- 'a.b.c.d': a server joined by name is looked up once (LuaSocket's dns)
function LOCK.host(h)
  h = tostring(h or ''):lower():match('^%s*(.-)%s*$')
  if h == '' or h:match('^%d+%.%d+%.%d+%.%d+$') then return h end
  if LOCK.dns[h] == nil then
    local ok, ip = pcall(function()
      local sock = M._video and M._video.lib and M._video.lib()
      return sock and sock.dns and sock.dns.toip(h)
    end)
    LOCK.dns[h] = ok and type(ip) == 'string' and ip ~= '' and ip or false
  end
  return LOCK.dns[h] or h
end

-- the BeamMP server you're on (or joining): 'ip:port' + its name; nil in single player
function LOCK.current()
  local net = MPCoreNetwork
  if type(net) ~= 'table' or type(net.getCurrentServer) ~= 'function' then return nil end
  local inMp = (type(net.isMPSession) == 'function' and net.isMPSession()) or (type(net.isGoingMPSession) == 'function' and net.isGoingMPSession())
  if not inMp then return nil end
  local cs = net.getCurrentServer()
  if type(cs) ~= 'table' then return nil end
  local port = cs.port ~= nil and tostring(cs.port):match('^%s*(%d+)') or nil
  return (cs.ip ~= nil and port) and (LOCK.host(cs.ip) .. ':' .. port) or nil, type(cs.name) == 'string' and cs.name or ''
end

-- a Baja75 server: its address, or one of the names in its name (BeamMP colour codes like ^1 or ^l taken out; each name
-- is looked at once)
function LOCK.isBaja(addr, name)
  if addr and LOCK.allowed[addr] then return true end
  local plain = tostring(name or ''):gsub('%^.', ''):sub(1, 120)
  if LOCK.nameSeen[plain] == nil then
    local hit = false
    for _, n in ipairs(LOCK.NAMES) do
      for i = 1, #plain - n[1] + 1 do
        if LOCK.digest(plain:sub(i, i + n[1] - 1)) == n[2] then hit = true; break end
      end
      if hit then break end
    end
    LOCK.nameSeen[plain] = hit
  end
  return LOCK.nameSeen[plain]
end

-- on a Baja75 server? (looked at once a second; force = now). A change tells the screen.
function LOCK.check(force)
  if not LOCK.applies() then return true end
  local now = os.clock()
  if not force and LOCK.server ~= nil and now - LOCK.t < LOCK.EVERY then return LOCK.server end
  LOCK.t = now
  local ok, addr, name = pcall(LOCK.current)
  if not ok then addr, name = nil, nil end
  local on = LOCK.isBaja(addr, name)
  local was = LOCK.server
  LOCK.server, LOCK.at = on, addr
  if LOCK.LOGIN then pcall(LOCK.LOGIN.watch) end -- signed in? (left a BeamMP session = signed out)
  if was ~= on then
    log_('I', on and ('Baja75 server ' .. tostring(addr) .. ' (' .. tostring(name) .. '): every feature open')
      or ('not on a Baja75 server (' .. tostring(addr or 'single player') .. '): ' .. PNK.EDITION .. ' edition limits'))
    if was ~= nil then
      if LOCK.LIC and LOCK.LIC.st then pcall(LOCK.LIC.tick, true) end -- (this hello carries the key state too)
      sendHello(false)
      if course and course.name and course.source then pcall(M.loadCourse, course.name, course.source) end -- waypoints this edition hides / shows
      sendList()
    end
  end
  if LOCK.LIC and LOCK.LIC.st then pcall(LOCK.LIC.tick) end
  return on
end

-- for the hello: what is open
function LOCK.state()
  if not LOCK.applies() then return nil end
  local on = LOCK.check()
  return { server = on, password = LOCK.password or nil, unlocked = LOCK.unlocked() or nil, ed = PNK.ed(), lic = LOCK.LIC.ui(),
    admin = LOCK.LIC.adminOn() and (LOCK.LIC.adminEnd - os.time()) or nil, mp = LOCK.at ~= nil or nil, courses = LOCK.limited() and LOCK.courseCount() or nil,
    maxCourses = LOCK.limited() and LOCK.maxCourses() or nil, login = LOCK.LOGIN and LOCK.LOGIN.ui() or nil } -- (the addresses stay in here: never shown)
end

-- the password is checked against its digest (salted FNV-1a with murmur3's final mix, 64 rounds; the text isn't kept
-- anywhere). Plain double arithmetic, every product under 2^53.
function LOCK.mul(a, b) return (a * (b % 65536) + (a * math.floor(b / 65536)) % 65536 * 65536) % 4294967296 end
function LOCK.fnv(s, h)
  local b = bit or require('bit')
  local function x(a, c) return b.bxor(a, c) % 4294967296 end
  for _ = 1, 64 do
    for i = 1, #s do
      h = x(h, s:byte(i))
      h = (h * 403 + b.lshift(h, 24) % 4294967296) % 4294967296
    end
    h = x(h, math.floor(h / 65536)); h = LOCK.mul(h, 0x85ebca6b)
    h = x(h, math.floor(h / 8192)); h = LOCK.mul(h, 0xc2b2ae35)
    h = x(h, math.floor(h / 65536))
  end
  return h
end
function LOCK.digest(pw)
  pw = tostring(pw or '')
  return string.format('%08x%08x', LOCK.fnv('b75:' .. pw, 2166136261), LOCK.fnv(pw .. ':txl', 84696351))
end

-- a locked part asked for (a key, or the screen got past its own lock): the screen asks for the password
function LOCK.ask(what) trigger('locked', { what = what }) end

-- the Common Edition: 2 courses of the player's own in total (recorded, imported or copied, every map); deleting one
-- frees a slot. Recording only in single player or on a Baja75 server (not on other BeamMP servers).
LOCK.MAX_COURSES = 2   -- the Common Edition (the Free Edition: 1, LOCK.maxCourses)
function LOCK.maxCourses() return PNK.EDITION == 'free' and 1 or PNK.EDITION == 'onyx' and 3 or LOCK.MAX_COURSES end
function LOCK.limited() return LOCK.freeTier() or PNK.EDITION == 'onyx' end -- editions with a limit on courses of your own
LOCK.SKIP_DIRS = { server = true, gpx = true, serverpack = true, times = true, sounds = true, music = true, videos = true, cache = true, rally = true }
function LOCK.courseCount()
  local n = 0
  local ok, dirs = pcall(function() return FS:findFiles(USER_ROOT .. '/', '*', 0, false, true) end)
  for _, d in ipairs(ok and type(dirs) == 'table' and dirs or {}) do
    local map = tostring(d):gsub('\\', '/'):gsub('/$', ''):match('([^/]+)$')
    if map and not LOCK.SKIP_DIRS[map:lower()] then
      for _, f in ipairs(listFiles(USER_ROOT .. '/' .. map, '%.json$')) do
        if not f:find('%.wpt%.json$') and f:sub(1, 1) ~= '_' then n = n + 1 end
      end
    end
  end
  return n
end
-- may the Common Edition add a course now? (what = 'record' | 'import' | 'copy'); says why not
function LOCK.commonRoom(what)
  if not LOCK.limited() or LOCK.check(true) or PNK.ed() == 'full' then return true end
  if what == 'record' and PNK.EDITION == 'free' then toast('Recording needs the product key: contact Baja75 on Patreon', 'warning'); return false end
  if what == 'record' and LOCK.at and PNK.EDITION ~= 'onyx' then toast('Recording is off on this server (Common Edition): record in single player or on a Baja75 server', 'warning'); return false end
  if LOCK.courseCount() >= LOCK.maxCourses() then
    toast('The ' .. (PNK.EDITION == 'free' and 'Free' or PNK.EDITION == 'onyx' and 'Onyx' or 'Common') .. ' Edition keeps ' .. LOCK.maxCourses() .. (LOCK.maxCourses() == 1 and ' course' or ' courses') .. ': delete one of yours (MENU > Courses) to ' .. (what == 'record' and 'record' or what == 'import' and 'import' or 'save') .. ' another', 'warning')
    return false
  end
  return true
end


-- keys (see dev/): only digests here
local LIC = {
KEYS = { ['fe215850c7f2a9ba'] = 11, ['cbcca88d9adfc00e'] = 12, ['26f5da19535df449'] = 13, ['996f36e883e74cab'] = 14, ['76957a008d372672'] = 21, ['d2d82e797fdb8082'] = 22, ['418d4b568c3f493d'] = 23, ['b5d80f34ed96913c'] = 24, ['2c3370e52712d084'] = 31, ['de7a8a9ee61238e2'] = 32, ['5dc1cedb72c8c730'] = 33, ['5e9a50101075997b'] = 34, ['f51729b9a3ad96ea'] = 41, ['a336ced456380abe'] = 51, ['21c41e55bea6c56a'] = 61, ['a8b4b3abd2474349'] = 62, ['e11777f06a1bb644'] = 63, ['921fea374cce9e7b'] = 64, ['8e65368c95871981'] = 71 },
ADMIN = 'fc1190809ebc1abb',
  FILE = USER_ROOT .. '/cache/sys.dat', DAY = 86400, SALT = 'b75nu', st = nil, adminEnd = nil, adminUsed = false, last = nil,
}
LOCK.LIC = LIC
local function licNorm(t) return tostring(t or ''):upper():gsub('[^A-Z0-9]', '') end
function LIC.gameVer()
  local v = type(beamng_version) == 'string' and beamng_version or ''
  return v:match('^(%d+%.%d+)') or v
end
function LIC.sign(t)
  local parts = { tostring(t.first), tostring(t.ser), tostring(t.stg), tostring(t.exp), tostring(t.l1), tostring(t.byp),
    tostring(t.gv), tostring(t.dead), LIC.SALT }
  local ext = LIC.ext(t) -- v3.1.8 fields (key history, C / F keys, the BeamMP name): only signed when there are any,
  if ext ~= '' then parts[#parts + 1] = ext end -- so a sys.dat from before stays valid
  local ext2 = LIC.ext2(t) -- v3.1.9 (the server day): the same way
  if ext2 ~= '' then parts[#parts + 1] = ext2 end
  return LOCK.digest(table.concat(parts, '|'))
end
-- v3.1.9: time on a Baja75 server today, the day the last extra day was earned, the extra day's end
function LIC.ext2(t)
  if t.srvSec == nil and t.srvDay == nil and t.bonusDay == nil and t.bexp == nil then return '' end
  return table.concat({ 'v9', tostring(t.srvSec), tostring(t.srvDay), tostring(t.bonusDay), tostring(t.bexp) }, ';')
end
-- the v3.1.8 fields as one line, always in the same order
function LIC.ext(t)
  local function map(m)
    if type(m) ~= 'table' then return '' end
    local ks = {}
    for k in pairs(m) do ks[#ks + 1] = tostring(k) end
    table.sort(ks)
    for i, k in ipairs(ks) do ks[i] = k .. '=' .. tostring(m[k] or m[tonumber(k)]) end
    return table.concat(ks, ',')
  end
  local e = { map(t.hist), map(t.rem), tostring(t.named), tostring(t.only), tostring(t.fexp), tostring(t.fver), tostring(t.fdead), tostring(t.mpn) }
  local s = table.concat(e, ';')
  return s == ';;nil;nil;nil;nil;nil;nil' and '' or s
end
function LIC.save()
  local t = LIC.st
  t.sig = LIC.sign(t)
  pcall(writeJson, LIC.FILE, t, false)
end
function LIC.now()
  local t, n = LIC.st, os.time()
  if t and t.seen and n < t.seen then n = t.seen end -- the clock never goes back
  if t then t.seen = n end
  return n
end
function LIC.load()
  local t = readJson(LIC.FILE)
  if type(t) ~= 'table' or t.sig ~= LIC.sign(t) then
    -- first start on this PC (or the file was edited: it starts over without anything entered)
    t = { first = os.time(), stg = 0, gv = LIC.gameVer() }
    LIC.st = t
    LIC.save()
    return
  end
  LIC.st = t
  if t.fver and t.fver ~= VERSION then -- that key's time ends with any new mod version (it stays used)
    t.fexp, t.fver, t.fdead = nil, nil, nil
    LIC.save()
  end
  local gv = LIC.gameVer()
  if gv ~= '' and t.gv ~= gv then -- a new BeamNG.drive version: the time starts again
    local n = LIC.now()
    t.first, t.gv, t.dead = n, gv, nil
    if t.ser and t.stg and t.stg > 0 and t.exp ~= -1 then t.exp = n + LIC.span(t.ser * 10 + t.stg) end
    LIC.save()
  end
end
function LIC.span(n)
  local s, k = math.floor(n / 10), n % 10
  if s == 1 then return 30 * LIC.DAY end
  if s == 2 then return k == 4 and -1 or 30 * k * LIC.DAY end
  if s == 3 then return (k == 4 and 30 or 7 * k) * LIC.DAY end
  return -1
end
function LIC.inMp() return LOCK.at ~= nil and not LOCK.server end -- on a BeamMP server that isn't a Baja75 one
function LIC.adminOn() return LIC.adminEnd ~= nil and os.time() < LIC.adminEnd end
-- the time a key gives, right now (true / false)
function LIC.active()
  local t = LIC.st
  if not t then return false end
  if t.byp then return true end
  if LIC.inMp() then return t.l1 == true end
  if t.ser == 2 and LOCK.at then return false end -- (only reached on a Baja75 server, which opens everything anyway)
  local n = LIC.now()
  if t.exp == -1 then return true end
  if t.exp and n < t.exp then return true end
  if t.fexp and n < t.fexp then return true end
  if t.bexp and n < t.bexp then return true end -- v3.1.9: the extra day from a Baja75 server
  if not t.ser and not LOCK.freeTier() and n < (t.first or n) + 30 * LIC.DAY then return true end
  return false
end
-- a 71 ran out: the error screen (until a new mod version; not on a Baja75 server or in the admin hour)
function LIC.bsod()
  local t = LIC.st
  if not t or not t.fexp then return false end
  if not t.fdead and LIC.now() >= t.fexp then t.fdead = true; LIC.save() end
  return t.fdead == true and not LOCK.server and not LIC.adminOn()
end
function LIC.dead()
  local t = LIC.st
  if not t or t.byp or t.l1 or LOCK.server or LIC.adminOn() then return false end
  if t.bexp and LIC.now() < t.bexp then return false end -- the extra day opens a disabled unit too
  if not t.dead and t.ser == 3 and t.stg == 4 and t.exp and t.exp ~= -1 and LIC.now() >= t.exp then t.dead = true; LIC.save() end
  return t.dead == true
end
-- for the screen: what is open, how long for, and why not (no key details)
function LIC.ui()
  local t = LIC.st or {}
  local n, on = LIC.now(), LIC.active()
  local u = { on = on or nil, dead = LIC.dead() or nil, bsod = LIC.bsod() or nil }
  local fOn = t.fexp and n < t.fexp
  if on and t.exp and t.exp ~= -1 and (n < t.exp or not fOn) then u.left = t.exp - n
  elseif on and not t.ser and not t.byp and not t.l1 and not fOn then u.left = (t.first or n) + 30 * LIC.DAY - n end
  if on and (t.exp == -1 or t.byp) then u.life = true end
  if on and t.ser == 3 and t.exp and t.exp ~= -1 and u.left then u.cd, u.trial = u.left, true end -- trial keys: the countdown by the clock
  -- (every other key with an end counts down in MENU > Display > License; 71 shows none)
  if on and t.bexp and n < t.bexp and not (t.exp and t.exp ~= -1 and n < t.exp) and not t.byp and t.exp ~= -1 then
    u.left, u.cd, u.bonus, u.trial = t.bexp - n, nil, true, nil -- the extra day is what keeps it open (License tab countdown)
  end -- v3.1.8: a countdown for every key with an end (71 has none)
  if t.named then u.name = LIC.who() end -- the name on the power-on screen
  if LIC.inMp() and not t.l1 and not t.byp then u.why = 'server'
  elseif not on and t.ser == 1 and t.stg == 4 then u.why = 'pack'
  elseif not on and t.ser then u.why = 'ended' end
  return u
end
-- the named key's name: the last BeamMP name (not a Guest) seen on this PC, else the unit's sign-in name; nil = the edition's word
function LIC.who()
  local t = LIC.st or {}
  if type(t.mpn) == 'string' and t.mpn ~= '' then return t.mpn end
  local L = LOCK.LOGIN
  if L and L.applies() then local n = L.current(); if n then return n end end
  return nil
end
-- a BeamMP name (not a Guest) is remembered on this PC (for the named key)
function LIC.seeName()
  local L, t = LOCK.LOGIN, LIC.st
  if not (L and t) then return end
  local nick = L.mpName()
  if nick and nick ~= t.mpn then t.mpn = nick; LIC.save(); return true end
end
-- once a second (from LOCK.check): an unlock ran out, or a key's time came: the screen is told
-- v3.1.9: an hour on a Baja75 server (once per calendar day) earns an extra day: +24 h on a running key with an end,
-- otherwise 24 h open from now (or from the end of the first 30 days / an earlier extra day). Not for units open for good,
-- not in the Onyx Edition.
LIC.BONUS_NEED, LIC.bonusAt = 3600, nil
function LIC.full()
  local t = LIC.st or {}
  return t.byp == true or t.exp == -1
end
function LIC.serverTime()
  local t = LIC.st
  if not t or PNK.EDITION == 'onyx' then return end
  local now = os.time()
  local dt = LIC.bonusAt and math.min(5, math.max(0, now - LIC.bonusAt)) or 0
  LIC.bonusAt = now
  if not LOCK.server or LIC.full() then return end
  local today = os.date('%Y-%m-%d', LIC.now())
  if t.srvDay ~= today then t.srvDay, t.srvSec = today, 0 end
  if t.bonusDay == today then return end
  t.srvSec = (t.srvSec or 0) + dt
  if t.srvSec < LIC.BONUS_NEED then
    if math.floor(t.srvSec) % 60 < dt then LIC.save() end -- kept about once a minute
    return
  end
  local n = LIC.now()
  t.bonusDay = today
  if t.exp and t.exp ~= -1 and n < t.exp then t.exp = t.exp + LIC.DAY
  else
    local base = n
    if t.bexp and t.bexp > base then base = t.bexp end
    if not t.ser and not LOCK.freeTier() and (t.first or n) + 30 * LIC.DAY > base then base = (t.first or n) + 30 * LIC.DAY end
    t.bexp = base + LIC.DAY
  end
  LIC.save()
  log_('I', 'an hour on a Baja75 server: one extra day')
  toast('An hour on a Baja75 server: 1 extra day added', 'success')
  LIC.last = -1 -- the screen hears it
end
function LIC.tick(quiet)
  pcall(LIC.serverTime)
  if LIC.adminEnd and os.time() >= LIC.adminEnd then
    LIC.adminEnd = nil
    log_('I', 'admin unlock ended (again after a game restart)')
    toast('Admin access ended', 'info')
  end
  local named = LIC.seeName() and LIC.st.named
  local now = (LOCK.unlocked() and 1 or 0) + (LIC.dead() and 2 or 0) + (LIC.adminOn() and 4 or 0) + (LIC.bsod() and 8 or 0)
  if named then LIC.last = -1 end -- a new name for the power-on screen
  if LIC.last ~= nil and now ~= LIC.last and not quiet then sendHello(false) end
  LIC.last = now
end
-- a typed key: the admin password, a license key, or nothing known
function LIC.enter(text)
  local d = LOCK.digest(licNorm(text))
  if d == LIC.ADMIN then
    if LIC.adminUsed then toast('Admin access can be used again after a game restart', 'warning'); return true end
    LIC.adminUsed, LIC.adminEnd = true, os.time() + 3600
    log_('I', 'admin unlock: every restriction off for 1 hour')
    toast('Admin access: every restriction off for 1 hour', 'success')
    return true
  end
  local n = LIC.KEYS[d]
  if not n then return false end
  local t = LIC.st
  t.hist = type(t.hist) == 'table' and t.hist or {}
  t.rem = type(t.rem) == 'table' and t.rem or {}
  local key = tostring(n)
  -- v3.1.8: 61-64 clear the key in use; 71 (see dev/)
  if n >= 61 and n <= 64 then return LIC.override(n) end
  if n == 71 then
    if next(t.hist) ~= nil or t.ser or t.l1 or t.byp then toast('This key can\'t be used on this PC', 'warning'); return true end
    if LIC.inMp() then
      trigger('notice', { text = 'Keys don\'t work on this server, only the password. Take a screenshot of this and send it to Baja75 for an unlocking key.', shot = true })
      return true
    end
    t.hist[key], t.fexp, t.fver, t.fdead = 1, LIC.now() + 30 * LIC.DAY, VERSION, nil
    LIC.save(); log_('I', 'key entered')
    toast('Unlocked', 'success')
    return true
  end
  if t.rem[key] == 0 then toast('This key was already used on this PC', 'warning'); return true end
  if t.only and n ~= 14 and n ~= 41 and n ~= 51 then toast('This key can\'t be used on this PC yet', 'warning'); return true end
  local ok = LIC.take(n)
  if ok then
    t.hist[key] = (t.hist[key] or 0) + 1
    if t.rem[key] then t.rem[key] = t.rem[key] - 1 end
    LIC.save()
  end
  return true
end
-- 61-64: each once per PC; each clears the key in use (and its time, and any lock it left)
function LIC.override(n)
  local t = LIC.st
  local key = tostring(n)
  if (t.hist[key] or 0) > 0 then toast('This key was already used on this PC', 'warning'); return true end
  -- keys entered before v3.1.8 have no history line: the series and step on this PC say which they were
  if t.ser and (t.stg or 0) > 0 then for k = 1, t.stg do local id = tostring(t.ser * 10 + k); t.hist[id] = t.hist[id] or 1 end end
  if t.l1 then t.hist['41'] = t.hist['41'] or 1 end
  if t.byp then t.hist['51'] = t.hist['51'] or 1 end
  local used = {}
  for k in pairs(t.hist) do if tonumber(k) and tonumber(k) < 61 then used[#used + 1] = k end end -- keys used before (not C keys)
  t.ser, t.stg, t.exp, t.l1, t.byp, t.dead = nil, 0, nil, nil, nil, nil
  t.fexp, t.fver, t.fdead = nil, nil, nil
  if n == 61 then -- no key used before goes in again
    for _, k in ipairs(used) do t.rem[k] = 0 end
    t.named, t.only = nil, nil
  elseif n == 62 then -- each key used before goes in once more
    for _, k in ipairs(used) do if t.rem[k] ~= 0 then t.rem[k] = 1 end end
    t.named, t.only = nil, nil
  elseif n == 63 then -- no limits on the next keys (the name stays)
    t.rem, t.only = {}, nil
  else -- the name on the power-on screen; only 14, 41 or 51 next
    t.named, t.only = true, true
  end
  t.hist[key] = 1
  LIC.save()
  log_('I', 'key cleared (override)')
  toast('Key cleared: enter your new key', 'success')
  sendHello(false)
  return true
end
-- a license key (11-51): the rules from v3.1.2 (after 64: 14 and 41 go straight in). true = taken
function LIC.take(n)
  local t = LIC.st
  if n == 51 then
    if PNK.EDITION == 'full' then trigger('notice', { text = 'This code is not needed: you already have full access.' }); return false end
    if LOCK.freeTier() then trigger('notice', { text = 'For full access, get the full Baja75 Navigation Unit from Baja75 on Patreon.', patreon = true }); return false end
    t.byp = true; LIC.save()
    toast('Unlocked for good', 'success'); log_('I', 'unlocked for good')
    return true
  end
  if LIC.inMp() and n ~= 41 then
    trigger('notice', { text = 'Keys don\'t work on this server, only the password. Take a screenshot of this and send it to Baja75 for an unlocking key.', shot = true })
    return false
  end
  if n == 41 then
    if (t.ser and t.stg == 4) or t.only then t.l1 = true; t.dead = nil; LIC.save(); toast('Unlocked for good on servers', 'success'); return true end
    toast('This key can\'t be used on this PC yet', 'warning'); return false
  end
  local s, k = math.floor(n / 10), n % 10
  local direct = t.only and n == 14 -- after 64: straight in
  if not direct then
    if t.ser and t.ser ~= s then toast('Another key is already in use on this PC', 'warning'); return false end
    if k <= (t.stg or 0) then toast('This key was already used on this PC', 'warning'); return false end
    if k ~= (t.stg or 0) + 1 then toast('This key can\'t be used on this PC yet', 'warning'); return false end
  elseif t.ser == 1 and t.stg == 4 then toast('This key was already used on this PC', 'warning'); return false end
  local now, span = LIC.now(), LIC.span(n)
  t.ser, t.stg, t.dead = s, k, nil
  if span == -1 then t.exp = -1
  elseif s == 1 then t.exp = math.max(now, (t.exp and t.exp ~= -1) and t.exp or ((t.first or now) + 30 * LIC.DAY)) + span
  else t.exp = now + span end
  LIC.save()
  log_('I', 'key entered')
  toast(t.exp == -1 and 'Unlocked for good' or ('Unlocked until ' .. os.date('%Y-%m-%d %H:%M', t.exp)), 'success')
  return true
end
-- unlocked: the password, a key's time, or the admin hour
function LOCK.unlocked() return LOCK.password or LIC.active() or LIC.adminOn() end

function LOCK.install()
  pcall(LIC.load)
  for _, s in ipairs(LOCK.SERVERS) do LOCK.allowed[s] = true end
  for name, what in pairs(LOCK.NEED) do
    local fn = M[name]
    if type(fn) == 'function' then
      M[name] = function(...)
        if PNK.EDITION == 'full' and not (LOCK.check() or LOCK.unlocked()) then return LOCK.ask(what) end
        return fn(...)
      end
    end
  end
  -- recording: a Baja75 server or the password (stopping always works)
  local start, toggle = M.startRecording, M.actionRecord
  M.startRecording = function(...)
    if PNK.ed() == 'common' or PNK.ed() == 'free' or PNK.ed() == 'onyx' then if not LOCK.commonRoom('record') then return end return start(...) end
    if not (LOCK.check(true) or LOCK.unlocked()) then return LOCK.ask('record') end return start(...)
  end
  M.actionRecord = function(...)
    if not rec and (PNK.ed() == 'common' or PNK.ed() == 'free' or PNK.ed() == 'onyx') then if not LOCK.commonRoom('record') then return end return toggle(...) end
    if not rec and not (LOCK.check(true) or LOCK.unlocked()) then return LOCK.ask('record') end return toggle(...)
  end
  -- the Common Edition's 2 courses: importing a GPX and saving a copy add one too
  local imp, cpy = M.importGpx, M.copyCourse
  M.importGpx = function(...) if not LOCK.commonRoom('import') then return end return imp(...) end
  M.copyCourse = function(...) if not LOCK.commonRoom('copy') then return end return cpy(...) end
  -- the Common Edition: those functions do nothing (a key pressed for one says so)
  for name in pairs(LOCK.COMMON_OFF) do
    local fn = M[name]
    if type(fn) == 'function' then
      M[name] = function(...)
        if PNK.ed() == 'common' or PNK.ed() == 'free' then
          if name:sub(1, 6) == 'action' then toast('Not in the ' .. (PNK.EDITION == 'free' and 'Free' or 'Common') .. ' Edition (open on Baja75 servers)', 'info') end
          return
        end
        return fn(...)
      end
    end
  end
  -- the Onyx Edition: no races, Chase Map, pacenote writing, server packs, YouTube or web pages; nothing to unlock
  for _, name in ipairs({ 'raceRoute', 'setChaseTarget', 'actionChaseNext', 'generatePacenotes', 'clearAutoPacenotes', 'addToServerPack', 'videoServer', 'openLink', 'readClipboard' }) do
    local fn = M[name]
    if type(fn) == 'function' then M[name] = function(...) if PNK.EDITION == 'onyx' then return end return fn(...) end end
  end
  -- the Free Edition: no video off the servers
  for _, name in ipairs({ 'videoServer', 'openLink', 'readClipboard' }) do
    local fn = M[name]
    if type(fn) == 'function' then M[name] = function(...) if PNK.ed() == 'free' then return end return fn(...) end end
  end
  -- the password: right = unlocked until the game closes
  M.unlock = function(pw)
    if PNK.EDITION == 'onyx' then toast('The Onyx Edition has nothing to unlock', 'info'); return end
    if LOCK.hasPassword() and LOCK.digest(pw) == LOCK.DIGEST then
      LOCK.password = true
      log_('I', 'unlocked with the password (until the game closes)')
      toast('Unlocked until the game closes', 'success')
    elseif not LIC.enter(pw) then
      toast(LOCK.hasPassword() and 'Wrong password or key' or 'Wrong key', 'error')
    end
    sendHello(false)
  end
  M.lockAgain = function()
    LOCK.password = false
    toast('Locked again', 'info')
    sendHello(false)
  end
end

-- ---------------------------------------------------------------- sign in (v3.1.7)
-- The full unit (Adventure Edition) and the Chase, Rally and Track Editions put a username on every recording and run.
-- No security: it is only a name. On a BeamMP server with a real BeamMP name (not a Guest) that name is used, signed in
-- by itself. Offline, as a Guest, or after leaving / losing the server: the player signs in (types a username) before
-- recording or racing; the sign-in lasts until the game closes or the player leaves a BeamMP session.
-- The username itself is kept by the screen (its settings, like the race number) and sent with setDriver / signIn.
local LOGIN = {
  EDITIONS = { full = true, chase = true, rally = true, track = true },
  on = false,       -- signed in by hand this session (the name is the driver name, RunLog.name)
  prevMp = nil,     -- on a BeamMP session at the last look (true / false; nil = not looked yet)
  pending = nil,    -- what was asked for before signing in: done right after
  lastKey = nil,    -- what the screen was last told
}
function LOGIN.applies() return LOGIN.EDITIONS[PNK.EDITION] == true end
function LOGIN.inMp()
  local ok, on = pcall(function() return MPCoreNetwork.isMPSession() end)
  return ok and on == true
end
-- the BeamMP name, when on a BeamMP session and not a Guest
function LOGIN.mpName()
  if not LOGIN.inMp() then return nil end
  local nick = ''
  pcall(function() nick = MPConfig.getNickname() end)
  nick = RunLog.clean(nick, 40)
  if nick == '' or nick:lower():find('guest', 1, true) then return nil end
  return nick
end
-- who is signed in: name, how ('beammp' / 'manual'), or nil
function LOGIN.current()
  local mp = LOGIN.mpName()
  if mp then return mp, 'beammp' end
  if LOGIN.on and RunLog.name ~= '' then return RunLog.name, 'manual' end
  return nil
end
function LOGIN.signedIn() return not LOGIN.applies() or LOGIN.current() ~= nil end
-- for the hello
function LOGIN.ui()
  if not LOGIN.applies() then return nil end
  local name, via = LOGIN.current()
  return { on = name ~= nil, name = name, via = via, mp = LOGIN.inMp() or nil, guest = (LOGIN.inMp() and not via) or nil }
end
-- once a second (from LOCK.check): leaving a BeamMP session signs out; any change tells the screen
function LOGIN.watch()
  if not LOGIN.applies() then return end
  local mp = LOGIN.inMp()
  if LOGIN.prevMp == true and not mp and LOGIN.on then
    LOGIN.on = false
    log_('I', 'left the BeamMP session: signed out')
  end
  LOGIN.prevMp = mp
  local name, via = LOGIN.current()
  local key = tostring(name) .. '|' .. tostring(via) .. '|' .. tostring(mp)
  if LOGIN.lastKey ~= nil and key ~= LOGIN.lastKey then sendHello(false) end
  LOGIN.lastKey = key
end
-- ask the screen for a sign-in; what was asked for runs once signed in
function LOGIN.ask(what, fn)
  LOGIN.pending = fn
  trigger('login', { what = what })
end
function LOGIN.guard(what, fn)
  return function(...)
    if LOGIN.signedIn() then return fn(...) end
    local args, n = { ... }, select('#', ...)
    LOGIN.ask(what, function() return fn(unpack(args, 1, n)) end)
  end
end
-- the screen signs in with a username (and the race number)
M.signIn = function(name, number)
  if not LOGIN.applies() then return end
  name = RunLog.clean(name, 40)
  if name == '' then toast('Type a username to sign in', 'warning'); return end
  M.setDriver(name, number)
  LOGIN.on = true
  local mp, via = LOGIN.current()
  toast('Signed in as ' .. mp .. (via == 'beammp' and ' (your BeamMP name)' or ''), 'success')
  LOGIN.lastKey = nil
  LOGIN.watch()
  sendHello(false)
  local fn = LOGIN.pending
  LOGIN.pending = nil
  if fn then fn() end
end
M.signOut = function()
  if not LOGIN.applies() then return end
  LOGIN.on, LOGIN.pending = false, nil
  if LOGIN.mpName() then toast('On this server you are signed in with your BeamMP name', 'info') end
  sendHello(false)
end
M.loginCancel = function() LOGIN.pending = nil end
function LOGIN.install()
  M.raceRoute = LOGIN.guard('race', M.raceRoute)
  M.raceStart = LOGIN.guard('race', M.raceStart)
  M.startRecording = LOGIN.guard('record', M.startRecording)
  local toggle = M.actionRecord
  M.actionRecord = function(...) if rec then return toggle(...) end return LOGIN.guard('record', toggle)(...) end -- stopping always works
end
LOCK.LOGIN = LOGIN

LOCK.install()
LOGIN.install()
M._lock = LOCK
end)() end


-- exposed for offline tests only
M._test = {
  buildCourse = buildCourse, project = project, safeName = safeName, safeLabel = safeLabel,
  setEdition = function(e) PNK.EDITION = e end, edition = function() return PNK.ed() end,
  buildGpx = buildGpx, parseGpx = parseGpx, buildRoadNetwork = buildRoadNetwork, levelId = levelId, terrainTiles = terrainTiles,
  state = function() return { course = course, progress = progress, rec = rec, chase = chase, vcpState = vcpState, me = me, race = race } end,
}

return M

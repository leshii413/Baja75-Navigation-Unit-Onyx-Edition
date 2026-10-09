-- Baja75 Navigation Unit - race passing alerts, the game side (v3.3).
--
-- One controller for both screens (the unit and the Alerts app): it handles the server's events, the single-player
-- requests, which screens are visible, the incoming alerts (one chime each, no duplicates, expiry), OK TO PASS and the
-- receipts. The screens only draw what it sends ('TreadXLGPS.pass') and report whether they are visible.
--
--   Request a pass (PASS or its key, while a race is running): every other vehicle within 100 m (3D, inclusive) of
--   your vehicle qualifies; its owner gets the alert if the unit or the Alerts app is on their screen.
--   * BeamMP: the server (Resources/Server/Baja75RaceAlerts) checks the race, your vehicle and the cooldown, picks the
--     recipients from its own positions and sends each one the alert. Nothing here decides who gets it.
--   * Single player: the same 100 m rule over the local vehicles; each one in range gets a scenario event
--     (extensions hook onBaja75PassRequest). AI cars have no screen and don't yield on their own.
--   * A scenario can send the player a request from an AI car: TreadXLGPS.passRequestFrom(vehicleId, name, number).
--
-- Events with the server (JSON strings): B75Pass_Hello, _Presence, _Request, _Shown, _Acknowledge (client -> server);
-- B75Pass_State, _Alert, _Result, _Response, _Clear (server -> client).
--
-- Nothing here needs the game: the main script passes in what it needs (P.init(env)), so it runs in the offline tests.

local P = {}

P.PROTO = 1
P.RADIUS2 = 10000     -- 100 m, inclusive, compared unrounded
P.COOLDOWN = 5        -- s between accepted requests (single player; the server keeps its own)
P.LIFE = 8            -- s an alert stays (single player; the server sends the time left)
P.HEART = 1           -- s between presence reports to the server
P.UI_LEASE = 3        -- s a screen counts as visible after its last report (they report every second)
P.DEDUP = 30          -- s an alert id is remembered (no second popup or chime)
P.MAX_SEEN = 128
P.DEBOUNCE = 0.6      -- s: a held or double-pressed key makes one request
P.HELLO_WAIT = 6      -- s without an answer: the server has no race alerts
P.HELLO_RETRY = 15    -- s between hellos after that (the plugin may be added or reloaded)
P.MAX_QUEUE = 5
P.SEEN_TOAST = 1.5    -- s: "Seen by" receipts are summed this long before the toast

local E   -- what the main script gives (see P.init)
local S   -- state

local floor, sqrt, huge = math.floor, math.sqrt, math.huge

local function finite(x) return type(x) == 'number' and x == x and x ~= huge and x ~= -huge end
-- cut to n bytes without splitting a UTF-8 character
local function cut(s, n)
  if #s <= n then return s end
  s = s:sub(1, n)
  local i = #s
  while i > 0 and s:byte(i) >= 128 and s:byte(i) < 192 do i = i - 1 end
  if i > 0 and s:byte(i) >= 192 then
    local b = s:byte(i)
    local need = b >= 240 and 4 or b >= 224 and 3 or 2
    if #s - i + 1 < need then s = s:sub(1, i - 1) end
  end
  return s
end
local function clean(s, n)
  s = tostring(s == nil and '' or s):gsub('[%c]', ' '):gsub('^%s+', ''):gsub('%s+$', '')
  return cut(s, n)
end
P.cut = cut

-- the 100 m rule: 3D world distance, inclusive; returns qualifies, squared distance (nil if a position is unusable)
function P.within(a, b)
  if type(a) ~= 'table' or type(b) ~= 'table' then return false, nil end
  local ax, ay, az = a.x or a[1], a.y or a[2], a.z or a[3]
  local bx, by, bz = b.x or b[1], b.y or b[2], b.z or b[3]
  if not (finite(ax) and finite(ay) and finite(az) and finite(bx) and finite(by) and finite(bz)) then return false, nil end
  local dx, dy, dz = bx - ax, by - ay, bz - az
  local d2 = dx * dx + dy * dy + dz * dz
  return d2 <= P.RADIUS2, d2
end

function P.reset()
  S = {
    inst = {},            -- [handle] = { kind = 'nav' | 'alerts', vis = bool, at = time }
    seen = {}, seenN = 0, -- [alertId] = time (incoming alerts already handled)
    alerts = {},          -- incoming, oldest first: { id, name, num, dist, vehs, exp, src, srcVid, test, shown }
    n = 0,                -- local counter (nonces, local alert ids)
    lastPress = -99, lastAccepted = -99,
    mp = false,           -- in a BeamMP session
    mode = 'local',       -- 'local' | 'wait' (hello sent) | 'ready' (server answered) | 'none' (no answer)
    srv = nil,            -- { raceId, state, eligible } from the server
    helloAt = nil, pending = {}, -- pending[nonce] = time sent
    presKey = nil, presAt = -99, presDirty = nil,
    pushKey = nil, pushAt = -99, tickAt = -99,
    seenBy = {},          -- [alertId] = { names = {}, at = first receipt }
    status = nil,         -- { text, level, until } for the Alerts app (the unit shows toasts)
  }
end
P.reset()

function P.init(env) E = env; P.reset() end
function P.state() return S end -- offline tests

local function now() return E.now() end
local function toast(text, level)
  S.status = { text = text, level = level or 'info', ['until'] = now() + 4 }
  if E.toast then E.toast(text, level) end
  S.pushKey = nil
end
local function send(name, t)
  if not E.send then return false end
  local ok, js = pcall(E.encode, t)
  if not ok or type(js) ~= 'string' then return false end
  return E.send(name, js) ~= false
end
local function decode(str)
  if type(str) ~= 'string' or #str > 8192 then return nil end
  local ok, t = pcall(E.decode, str)
  if ok and type(t) == 'table' then return t end
  return nil
end
local function markSeen(id)
  if S.seen[id] then return end
  S.seen[id] = now(); S.seenN = S.seenN + 1
  if S.seenN > P.MAX_SEEN then -- bounded: forget the oldest
    local oldId, oldT
    for k, t in pairs(S.seen) do if not oldT or t < oldT then oldId, oldT = k, t end end
    if oldId then S.seen[oldId] = nil; S.seenN = S.seenN - 1 end
  end
end

-- ---------------------------------------------------------------- which screens are on
-- each screen (the unit, the Alerts app; any number of copies) reports itself about once a second
function P.presence(handle, kind, visible)
  handle = clean(handle, 40)
  if handle == '' or (kind ~= 'nav' and kind ~= 'alerts') then return end
  if visible == nil then -- the screen was closed / removed
    if S.inst[handle] then S.inst[handle] = nil; S.presDirty = S.presDirty or now() end
    return
  end
  local was = S.inst[handle]
  S.inst[handle] = { kind = kind, vis = visible == true, at = now() }
  if not was or was.vis ~= (visible == true) then S.presDirty = S.presDirty or now(); S.pushKey = nil end
end

-- navHud: the unit's HUD app is visible; alerts: the Alerts app is; dash: the unit is on the vehicle's own screen
function P.visible()
  local t, cef = now(), true
  if E.cefVisible then local ok, v = pcall(E.cefVisible); if ok and v == false then cef = false end end
  local nav, alerts = false, false
  for h, i in pairs(S.inst) do
    if t - i.at > P.UI_LEASE then S.inst[h] = nil -- a screen that stopped reporting is gone
    elseif i.vis and cef then if i.kind == 'nav' then nav = true else alerts = true end end
  end
  local dash = false
  if E.dashVisible then local ok, v = pcall(E.dashVisible); dash = ok and v == true end
  return nav, alerts, dash
end
-- where the card goes: the unit's HUD app first, else the Alerts app (both have buttons), else the unit on the car's
-- own screen (from the driver's seat; OK TO PASS by key there), else nowhere
function P.surface()
  local nav, alerts, dash = P.visible()
  if nav then return 'nav', nav, alerts, dash end
  if alerts then return 'alerts', nav, alerts, dash end
  if dash then return 'nav', nav, alerts, dash end
  return nil, nav, alerts, dash
end

-- ---------------------------------------------------------------- what the screens show
local function cooldownLeft()
  local left = S.lastAccepted + P.COOLDOWN - now()
  return left > 0 and left or 0
end

-- PASS on the unit: shown while a race is running; can = it would send now
function P.button()
  if E.edition() == 'onyx' then return { show = false } end
  if S.mp then
    if S.mode == 'ready' and S.srv and S.srv.state == 'running' then
      if not S.srv.eligible then return { show = false } end
      local cd = cooldownLeft()
      return { show = true, can = cd == 0, cd = cd > 0 and math.ceil(cd) or nil }
    end
    if (S.mode == 'none' or S.mode == 'wait') and E.localRaceRunning() then
      return { show = true, can = false, why = S.mode == 'none' and 'unavailable' or 'connecting' }
    end
    return { show = false }
  end
  if E.localRaceRunning() then
    local cd = cooldownLeft()
    return { show = true, can = cd == 0, cd = cd > 0 and math.ceil(cd) or nil }
  end
  return { show = false }
end

function P.push(force)
  if not E.ui then return end
  local surf, nav, alerts, dash = P.surface()
  local t = now()
  local list = {}
  for i = #S.alerts, 1, -1 do -- newest first
    local a = S.alerts[i]
    list[#list + 1] = { id = a.id, name = a.name, num = a.num ~= '' and a.num or nil, dist = a.dist, vehs = a.vehs, test = a.test or nil,
      left = math.max(0, floor((a.exp - t) * 10 + 0.5) / 10), life = a.life, local_ = a.src == 'local' or nil }
  end
  local st = S.status and S.status['until'] > t and { text = S.status.text, level = S.status.level } or nil
  local b = P.button()
  local data = { surface = surf, alerts = list, alertsWin = alerts, navHud = nav, dash = dash, btn = b, status = st,
    mp = S.mp or nil, mode = S.mode }
  -- send when something changed, and twice a second while an alert counts down
  local key = (surf or '-') .. '|' .. tostring(nav) .. tostring(alerts) .. tostring(dash) .. '|' .. tostring(b.show) .. tostring(b.can) .. tostring(b.cd) .. tostring(b.why) ..
    '|' .. (st and st.text or '') .. '|' .. S.mode
  for _, a in ipairs(list) do key = key .. '|' .. a.id end
  if not force and key == S.pushKey and (#list == 0 or t - S.pushAt < 0.5) then return end
  S.pushKey, S.pushAt = key, t
  E.ui(data)
end

-- ---------------------------------------------------------------- incoming alerts
local function findAlert(id)
  for i, a in ipairs(S.alerts) do if a.id == id then return a, i end end
  return nil
end
local function removeAlert(id)
  local _, i = findAlert(id)
  if i then table.remove(S.alerts, i); S.pushKey = nil; return true end
  return false
end
function P.clearAll(src)
  local n = #S.alerts
  if src then
    for i = #S.alerts, 1, -1 do if S.alerts[i].src == src then table.remove(S.alerts, i) end end
  else S.alerts = {} end
  if #S.alerts ~= n then S.pushKey = nil end
end

-- a new alert: only while a screen shows it; one chime; the oldest goes when the queue is full
local function present(a)
  local surf, nav = P.surface()
  if not surf then return false end -- nobody would see it: no popup, no sound, no replay later
  S.alerts[#S.alerts + 1] = a
  while #S.alerts > P.MAX_QUEUE do table.remove(S.alerts, 1) end
  if E.chime then pcall(E.chime) end
  -- (the "seen" receipt comes from a screen that drew it: the HUD app or the Alerts app, never assumed here)
  S.pushKey = nil
  P.push(true)
  return true
end

function P.onAlert(str)
  if not S.mp then return end
  local t = decode(str)
  if not t or t.protocolVersion ~= P.PROTO or t.type ~= 'PASS_REQUEST' then return end
  local id = t.alertId
  if type(id) ~= 'string' or id == '' or #id > 80 then return end
  if S.seen[id] then return end -- the same alert again: no second popup or chime
  markSeen(id)
  local life = tonumber(t.expiresInMs)
  if not finite(life) or life <= 0 then return end
  life = math.min(life, 30000) / 1000
  local vehs, dist = {}, nil
  if type(t.recipientVehicles) == 'table' then
    for _, v in ipairs(t.recipientVehicles) do
      if type(v) == 'table' and finite(tonumber(v.vehicleId)) and #vehs < 8 then
        local d = tonumber(v.distanceAtSendMeters)
        if finite(d) then dist = dist and math.min(dist, d) or d end
        vehs[#vehs + 1] = { id = tonumber(v.vehicleId), dist = finite(d) and d or nil, label = E.ownVehicleLabel and E.ownVehicleLabel(tonumber(v.vehicleId)) or nil }
      end
    end
  end
  local a = { id = id, name = clean(t.senderDisplayName, 40), num = clean(t.senderRaceNumber, 8), dist = dist,
    vehs = #vehs > 0 and vehs or nil, exp = now() + life, life = life, src = 'mp', raceId = t.raceId }
  if a.name == '' then a.name = 'A driver' end
  -- one vehicle, the one you're in: no need to name it
  if a.vehs and #a.vehs == 1 and E.isCurrentOwn and E.isCurrentOwn(a.vehs[1].id) then a.vehs = nil end
  if not present(a) and E.log then E.log('I', 'pass alert ' .. id .. ' not shown: no screen visible') end
end

-- the screen drew the card: a receipt for the requester ("seen", which is not "OK TO PASS")
function P.shown(id)
  local a = findAlert(id)
  if not a or a.shown then return end
  a.shown = true
  if a.src == 'mp' and S.mp then send('B75Pass_Shown', { protocolVersion = P.PROTO, alertId = a.id }) end
end

function P.ack(id)
  local a = findAlert(id)
  if not a then return end
  if a.test then removeAlert(id); toast('Test alert: OK TO PASS (nothing was sent)', 'info'); P.push(true); return end
  if a.src == 'mp' then
    if S.mp then send('B75Pass_Acknowledge', { protocolVersion = P.PROTO, alertId = a.id }) end
    toast('OK TO PASS sent to ' .. a.name, 'success')
  elseif a.src == 'local' then
    if E.hook then E.hook('onBaja75PassAcknowledged', { alertId = a.id, sourceVehicleId = a.srcVid, targetVehicleId = E.playerVehicleId and E.playerVehicleId() or nil }) end
    toast('OK TO PASS: ' .. a.name, 'success')
  end
  removeAlert(id)
  P.push(true)
end
-- the key: OK TO PASS for the newest request
function P.ackNewest() local a = S.alerts[#S.alerts]; if a then P.ack(a.id) end end
-- Dismiss closes the card here only; it is not permission to pass
function P.dismiss(id) if removeAlert(id) then P.push(true) end end

-- ---------------------------------------------------------------- requesting a pass
local RESULT = {
  none_nearby = { 'No other drivers within 100 m', 'info' },
  no_race = { 'Pass requests work while a race is running', 'warning' },
  not_racer = { 'Only drivers in this race can request a pass', 'warning' },
  bad_vehicle = { 'Your race vehicle wasn\'t found on the server', 'warning' },
  no_position = { 'The server has no position for your vehicle yet: try again', 'warning' },
  rate = { 'Too many requests: slow down', 'warning' },
  nonce_conflict = { 'Pass request refused', 'warning' },
  bad_request = { 'Pass request refused', 'warning' },
}

function P.request()
  local t = now()
  if E.edition() == 'onyx' then return end
  if t - S.lastPress < P.DEBOUNCE then return end -- held / double press: one request
  S.lastPress = t
  if S.mp then
    if S.mode == 'none' then toast('This server has no Baja75 race alerts: pass requests are off here', 'warning'); return end
    if S.mode ~= 'ready' then toast('Connecting to the server\'s race alerts...', 'info'); return end
    if not (S.srv and S.srv.state == 'running') then toast(RESULT.no_race[1], 'warning'); return end
    if not S.srv.eligible then toast(RESULT.not_racer[1], 'warning'); return end
    local cd = cooldownLeft()
    if cd > 0 then toast(string.format('Wait %d s before the next pass request', math.ceil(cd)), 'info'); return end
    local vid = E.ownServerVehicleId and E.ownServerVehicleId()
    if not finite(vid) then toast('Get in your race vehicle first', 'warning'); return end
    S.n = S.n + 1
    local nonce = 'b75-' .. S.n .. '-' .. floor(t * 1000)
    S.pending[nonce] = t
    send('B75Pass_Request', { protocolVersion = P.PROTO, requestNonce = nonce, sourceVehicleId = vid })
    return nonce
  end
  -- single player: the same rule over the local vehicles
  if not E.localRaceRunning() then toast(RESULT.no_race[1], 'warning'); return end
  local cd = cooldownLeft()
  if cd > 0 then toast(string.format('Wait %d s before the next pass request', math.ceil(cd)), 'info'); return end
  local src = E.playerVehicleId and E.playerVehicleId()
  local sp = src ~= nil and E.vehiclePos(src) or nil
  if not sp then toast('Get in your race vehicle first', 'warning'); return end
  S.n = S.n + 1
  local id = 'local-' .. S.n
  local targets = {}
  for _, vid in ipairs(E.vehicleIds() or {}) do
    if vid ~= src then
      local ok, d2 = P.within(sp, E.vehiclePos(vid))
      if ok then targets[#targets + 1] = { vehicleId = vid, distance = sqrt(d2) } end
    end
  end
  if #targets == 0 then toast('No other vehicles within 100 m', 'info'); return id end
  S.lastAccepted = t
  for _, tg in ipairs(targets) do
    if E.hook then E.hook('onBaja75PassRequest', { alertId = id, sourceVehicleId = src, targetVehicleId = tg.vehicleId,
      distance = tg.distance, expiresInMs = P.LIFE * 1000 }) end
  end
  toast(string.format('Pass request: %d %s within 100 m (single player: no other drivers\' screens)', #targets, #targets == 1 and 'vehicle' or 'vehicles'), 'info')
  P.push(true)
  return id
end

-- a scenario / race script: an AI (or any) vehicle requests a pass from the player
function P.requestFrom(srcVid, name, number)
  if S.mp or E.edition() == 'onyx' then return false end
  local me = E.playerVehicleId and E.playerVehicleId()
  if me == nil or srcVid == nil or srcVid == me then return false end
  local ok, d2 = P.within(E.vehiclePos(srcVid), E.vehiclePos(me))
  if not ok then return false end
  S.n = S.n + 1
  local id = 'local-in-' .. S.n
  markSeen(id)
  return present({ id = id, name = clean(name ~= nil and name or 'Vehicle ' .. tostring(srcVid), 40), num = clean(number, 8),
    dist = sqrt(d2), exp = now() + P.LIFE, life = P.LIFE, src = 'local', srcVid = srcVid })
end

-- development only: a labelled test alert, nothing is sent
function P.test()
  S.n = S.n + 1
  local id = 'test-' .. S.n
  markSeen(id)
  return present({ id = id, name = 'TEST DRIVER', num = '000', dist = 42, exp = now() + P.LIFE, life = P.LIFE, src = 'test', test = true })
end

-- ---------------------------------------------------------------- server answers
function P.onState(str)
  local t = decode(str)
  if not t or t.protocolVersion ~= P.PROTO then return end
  local prev = S.srv
  S.srv = { raceId = type(t.raceId) == 'string' and t.raceId or nil, state = type(t.state) == 'string' and t.state or 'idle',
    eligible = t.eligible == true }
  S.mode = 'ready'
  -- another race, or the race stopped: its alerts are gone
  if S.srv.state ~= 'running' or (prev and prev.raceId ~= S.srv.raceId) then P.clearAll('mp') end
  if prev and prev.state ~= S.srv.state and S.srv.state == 'running' and S.srv.eligible then toast('Race on: PASS requests a pass from drivers within 100 m', 'info') end
  S.pushKey = nil
  P.push(true)
end

function P.onResult(str)
  local t = decode(str)
  if not t or t.protocolVersion ~= P.PROTO or type(t.requestNonce) ~= 'string' then return end
  if not S.pending[t.requestNonce] then return end -- not ours, or answered already
  S.pending[t.requestNonce] = nil
  local st = t.status
  if st == 'accepted' then
    S.lastAccepted = now()
    local d, v = tonumber(t.drivers) or 0, tonumber(t.vehicles) or 0
    toast(string.format('Pass request sent to %d %s', d, d == 1 and 'driver' or 'drivers') .. (v > d and string.format(' / %d vehicles', v) or ''), 'success')
  elseif st == 'cooldown' then
    local ms = tonumber(t.retryInMs) or 0
    S.lastAccepted = now() - P.COOLDOWN + ms / 1000
    toast(string.format('Wait %d s before the next pass request', math.max(1, math.ceil(ms / 1000))), 'info')
  elseif st == 'no_display' then
    local n = tonumber(t.nearby) or 0
    toast(string.format('%d %s within 100 m, but none has the Baja75 unit or alerts on screen', n, n == 1 and 'driver' or 'drivers'), 'info')
  elseif st == 'duplicate' then return
  else
    local r = RESULT[st] or { 'Pass request refused', 'warning' }
    toast(r[1], r[2])
  end
  P.push(true)
end

-- the requester hears back: a recipient's screen showed it ('shown'), or they pressed OK TO PASS ('ok')
function P.onResponse(str)
  local t = decode(str)
  if not t or t.protocolVersion ~= P.PROTO or type(t.alertId) ~= 'string' then return end
  local who = clean(t.playerName, 40)
  local num = clean(t.raceNumber, 8)
  if who == '' then who = 'A driver' end
  if num ~= '' then who = who .. ' #' .. num end
  if t.kind == 'ok' then toast(who .. ' \226\128\148 OK TO PASS', 'success')
  elseif t.kind == 'shown' then
    local s = S.seenBy[t.alertId] or { names = {}, at = now() }
    s.names[#s.names + 1] = who
    S.seenBy[t.alertId] = s
  end
end

local CLEARED = {
  ack_moved = 'Your OK TO PASS didn\'t count: no longer within 100 m',
  ack_expired = 'Your OK TO PASS was too late: that request had ended',
}
function P.onClear(str)
  local t = decode(str)
  if not t or t.protocolVersion ~= P.PROTO then return end
  if t.all == true then P.clearAll('mp')
  elseif type(t.alertId) == 'string' then removeAlert(t.alertId) end
  if CLEARED[t.reason] then toast(CLEARED[t.reason], 'warning') end
  P.push(true)
end

-- ---------------------------------------------------------------- lifecycle
local function presenceMsg()
  local nav, alerts, dash = P.visible()
  return { protocolVersion = P.PROTO, navVisible = (nav or dash) == true, alertWindowVisible = alerts == true }
end

local function hello()
  S.helloAt = now()
  if E.addHandlers then E.addHandlers() end -- (again: a reconnect replaces them, never adds a second set)
  send('B75Pass_Hello', presenceMsg())
end

function P.leaveMp()
  S.mp, S.mode, S.srv, S.pending = false, 'local', nil, {}
  P.clearAll('mp')
  S.seenBy = {}
  S.pushKey = nil
end
function P.mapChanged() P.clearAll(); S.pending = {}; S.seenBy = {}; S.pushKey = nil end
-- single player: a request's vehicle reset or removed
function P.vehicleGone(vid)
  local gone = false
  for i = #S.alerts, 1, -1 do if S.alerts[i].src == 'local' and S.alerts[i].srcVid == vid then table.remove(S.alerts, i); gone = true end end
  if gone then P.push(true) end
end

function P.update()
  if not E or E.edition() == 'onyx' then return end
  local t = now()
  if t - S.tickAt < 0.1 then return end
  S.tickAt = t
  local mp = E.isMP() == true
  if mp and not S.mp then S.mp = true; S.mode = 'wait'; P.clearAll(); hello()
  elseif not mp and S.mp then P.leaveMp() end
  if S.mp then
    if S.mode == 'wait' and t - S.helloAt > P.HELLO_WAIT then S.mode = 'none'; S.pushKey = nil
    elseif S.mode == 'none' and t - S.helloAt > P.HELLO_RETRY then hello() end
    if S.mode == 'ready' then
      local m = presenceMsg()
      local key = tostring(m.navVisible) .. tostring(m.alertWindowVisible)
      if key ~= S.presKey then S.presDirty = S.presDirty or t end
      -- a change goes out after a short settle; otherwise every second (the server forgets a screen after 6 s)
      if (S.presDirty and t - S.presDirty >= 0.25) or t - S.presAt >= P.HEART then
        send('B75Pass_Presence', m)
        S.presKey, S.presAt, S.presDirty = key, t, nil
      end
    end
    for nonce, at in pairs(S.pending) do if t - at > 10 then S.pending[nonce] = nil end end
  end
  -- expired alerts go, and never come back
  for i = #S.alerts, 1, -1 do if S.alerts[i].exp <= t then table.remove(S.alerts, i); S.pushKey = nil end end
  -- every screen closed: what was on them is dropped (no replay when one opens again)
  if #S.alerts > 0 and not P.surface() then S.alerts = {}; S.pushKey = nil end
  for id, at in pairs(S.seen) do if t - at > P.DEDUP then S.seen[id] = nil; S.seenN = S.seenN - 1 end end
  for id, s in pairs(S.seenBy) do
    if t - s.at >= P.SEEN_TOAST then
      S.seenBy[id] = nil
      local n = #s.names
      toast('Seen by ' .. (n == 1 and s.names[1] or n .. ' drivers'), 'info')
    end
  end
  if S.status and S.status['until'] <= t then S.status = nil; S.pushKey = nil end
  P.push(false)
end

return P

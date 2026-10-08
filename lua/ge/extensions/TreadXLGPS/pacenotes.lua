-- Tread XL GPS (Baja75) - rally pacenotes on top of BeamNG's own rally pacenote system (0.39+).
--
-- Nothing from the game is copied into the mod:
--   * words, 1-6 numbering, corner sizes, colours and icon names come from the game's English "enthusiast"
--     pacenote style, required live from /lua/ge/extensions/gameplay/rally/compositors/styles/english/
--   * the voice is one of the game's co-driver voicepacks (/lua/.../rally/compositors/voicepacks/<pack>/audio),
--     played through the game's co-driver intercom (Engine.Audio.intercomPlayPacenote), like a rally stage
--   * the visual tiles use the same payload as the game's visual pacenotes (guihooks 'showVisualPacenote2')
-- A small built-in table is only used if a game version doesn't have the rally style files.
--
-- A pacenote as stored on a course waypoint (field "pn"):
--   d   = -1 left | 1 right | 0 none (hazard-only note)
--   c   = 'one'..'six' | 'hairpin' | 'openHairpin' | 'tightHairpin' | 'square' | 'flat'
--   len = 'short' | 'halfLong' | 'long' | 'extraLong'      (numbered corners)
--   sh  = 'opens' | 'tightens' | 'overCrest' | ...           (corner shape)
--   ca  = 0..3 (care, caution, double caution)
--   m   = { up to 3 modifier ids: 'dontCut', 'crest', 'jump', ... }
--   arc = corner length in metres (auto pacenotes), used for the distance call to the next note

local P = {}

local STYLE_PATH = '/lua/ge/extensions/gameplay/rally/compositors/styles/english/enthusiast'
local VOICE_DIR = '/lua/ge/extensions/gameplay/rally/compositors/voicepacks/'
local WANT_STYLE = 'english/enthusiast'
local MAX_MODS = 3

local floor, abs, sqrt, atan2, pi = math.floor, math.abs, math.sqrt, math.atan2, math.pi

-- ------------------------------------------------------------------ style (native, or the built-in fallback)
local function fallbackStyle()
  local crimson, deepCrimson, orange, deepOrange = '#ff1744', '#c4002f', '#ff8a00', '#c96500'
  local function tile(icon, text, bg, stroke) return { icon = icon, text = text, colorBg = bg, colorStroke = stroke, colorNoteIcon = '#181a1d', colorNoteText = '#181a1d' } end
  local function iv(icon) return { icon = icon, colorIcon = '#181a1d', colorBg = '#a855f7', colorStroke = '#7e22ce' } end
  local function cut(icon, bg, stroke) return { additionalNote = { icon = icon, color = '#181a1d', colorBg = bg, colorStroke = stroke } } end
  local lengths = {
    { id = 'short', text = 'short' }, { id = 'standard' }, { id = 'halfLong', text = 'half long' },
    { id = 'long', text = 'long' }, { id = 'extraLong', text = 'extra long' },
  }
  return {
    distance = { links = { { threshold = 5 }, { threshold = 20, text = 'into' }, { threshold = 40, text = 'and' } },
      units = { base = 'm', large = 'km', point = 'point' }, rounding = { small = 10, medium = 50, mediumThreshold = 100, large = 250, largeThreshold = 1000 }, max = 2000 },
    componentTypes = {
      corner = {
        direction = { [-1] = 'left', [1] = 'right' },
        numbering = {
          intensity = {
            { id = 'one', text = 'one', diameter = { min = 0, max = 35 }, visual = tile('turn1', '1', crimson, deepCrimson) },
            { id = 'two', text = 'two', diameter = { min = 35, max = 65 }, visual = tile('turn2', '2', orange, deepOrange) },
            { id = 'three', text = 'three', diameter = { min = 65, max = 116 }, visual = tile('turn3', '3', '#ffd600', '#c7a500') },
            { id = 'four', text = 'four', diameter = { min = 116, max = 190 }, visual = tile('turn4', '4', '#00d5ff', '#008fb3') },
            { id = 'five', text = 'five', diameter = { min = 190, max = 260 }, visual = tile('turn5', '5', '#33a6ff', '#005ecb') },
            { id = 'six', text = 'six', diameter = { min = 260 }, visual = tile('turn6', '6', '#00e676', '#00a152') },
          },
          lengthsByIntensity = { one = lengths, two = lengths, three = lengths, four = lengths, five = lengths, six = lengths },
        },
        shapes = {
          opens = { text = 'opens', visual = { icon = 'mathLessThan' } }, tightens = { text = 'tightens', visual = { icon = 'mathGreaterThan' } },
          overCrest = { text = 'over crest', variant = '2', visual = { icon = 'crest' } }, opensOverCrest = { text = 'opens over crest', visual = { icon = 'crest' } },
          tightensOverCrest = { text = 'tightens over crest', visual = { icon = 'crest' } }, tightensDown = { text = 'tightens down', visual = { icon = 'mathGreaterThan' } },
          opensAndTightens = { text = 'opens and tightens' }, tightensAndOpens = { text = 'tightens and opens' },
        },
        descriptors = {
          flat = { text = 'flat', visual = tile('turn6', 'FL', '#00e676', '#00a152') },
          square = { text = 'square', visual = tile('turnSq', 'SQ', orange, deepOrange) },
          hairpin = { text = 'hairpin', visual = tile('turnHp', 'HP', crimson, deepCrimson) },
          openHairpin = { text = 'open hairpin', visual = tile('turnHp', 'HP', crimson, deepCrimson) },
          tightHairpin = { text = 'tight hairpin', visual = tile('turnHp', 'HP', crimson, deepCrimson) },
        },
      },
      caution = {
        levels = { 'care', 'caution', 'double caution' },
        levelVisuals = {
          { colorBg = '#181a1d', colorStroke = '#ffff00', colorNoteIcon = '#ffff00', colorNoteText = '#ffff00' },
          { colorBg = '#181a1d', colorStroke = '#ff0000', colorNoteIcon = '#ff0000', colorNoteText = '#ff0000' },
          { colorBg = '#181a1d', colorStroke = '#ff0000', colorNoteIcon = '#ff0000', colorNoteText = '#ff0000' },
        },
      },
      modifiers = {
        dontCut = { text = "don't cut", visual = cut('scissorsSlashed', crimson, deepCrimson) }, cut = { text = 'cut', visual = cut('scissors', '#00e676', '#00a152') },
        keepIn = { text = 'keep in' }, keepLeft = { text = 'keep left' }, keepRight = { text = 'keep right' }, keepMiddle = { text = 'keep middle' },
        crest = { text = 'crest', visual = iv('crest') }, bigCrest = { text = 'big crest', visual = iv('crest') }, overCrest = { text = 'over crest', variant = '1', visual = iv('crest') },
        jump = { text = 'jump', visual = iv('jumpOverBump') }, bigJump = { text = 'big jump', visual = iv('jumpOverBump') }, overJump = { text = 'over jump', visual = iv('jumpOverBump') },
        bump = { text = 'over bump', visual = iv('bump') }, bumpy = { text = 'bumpy', visual = iv('bumps') }, dip = { text = 'dip', visual = iv('pothole') }, badDip = { text = 'bad dip', visual = iv('pothole') },
        watersplash = { text = 'watersplash', visual = iv('water') }, overBridge = { text = 'over bridge', visual = iv('bridge') }, narrowBridge = { text = 'narrow bridge', visual = iv('bridge') },
        narrows = { text = 'narrows', visual = iv('narrows') }, atJunction = { text = 'at junction' }, brake = { text = 'brake' }, slowing = { text = 'slowing' }, slippy = { text = 'slippy' },
        ontoGravel = { text = 'onto gravel' }, ontoTarmac = { text = 'onto tarmac' }, ontoMud = { text = 'onto mud' }, ontoIce = { text = 'onto ice' },
        finish = { text = 'over finish', visual = { icon = 'finish', colorIcon = '#f2f2f2', colorBg = '#181a1d', colorStroke = '#f2f2f2' } }, toStop = { text = 'to stop' },
      },
    },
  }
end

local style, styleSource = nil, 'none'

function P.load()
  if style then return styleSource end
  local ok, s = pcall(require, STYLE_PATH)
  if ok and type(s) == 'table' and type(s.componentTypes) == 'table' and type(s.componentTypes.corner) == 'table' and type(s.distance) == 'table' then
    style, styleSource = s, 'game'
  else
    style, styleSource = fallbackStyle(), 'builtin'
  end
  return styleSource
end

local function ct() P.load(); return style.componentTypes end
local function cornerCfg() return ct().corner end
local function intensityList() return (cornerCfg().numbering or {}).intensity or {} end
local function intensityById(id)
  for _, e in ipairs(intensityList()) do if e.id == id then return e end end
  return nil
end

-- the game's rule for turning a phrase into its audio file name (compositorUtil.pacenoteHash)
local function phraseHash(text)
  local h = string.lower(text or '')
  h = h:gsub("'", ''):gsub('[^a-z0-9]', '_'):gsub('(_+)', '_'):gsub('^_', ''):gsub('_$', '')
  return h
end
P.phraseHash = phraseHash

-- ------------------------------------------------------------------ pacenotes
function P.normalize(pn)
  if type(pn) ~= 'table' then return nil end
  P.load()
  local c = cornerCfg()
  local out = { d = tonumber(pn.d) or 0 }
  if out.d ~= -1 and out.d ~= 1 then out.d = 0 end
  if out.d ~= 0 then
    local cc = tostring(pn.c or '')
    if intensityById(cc) or (c.descriptors and c.descriptors[cc] and cc ~= 'bare') then out.c = cc else out.c = 'three' end
    if intensityById(out.c) and pn.len and pn.len ~= 'standard' then
      for _, e in ipairs(((c.numbering or {}).lengthsByIntensity or {})[out.c] or {}) do
        if e.id == pn.len and e.text then out.len = e.id end
      end
    end
    if pn.sh and c.shapes and c.shapes[pn.sh] then out.sh = tostring(pn.sh) end
  end
  local ca = floor(tonumber(pn.ca) or 0)
  if ca >= 1 and ca <= 3 then out.ca = ca end
  local mods, seen = {}, {}
  local cm = ct().modifiers or {}
  for _, m in ipairs(type(pn.m) == 'table' and pn.m or {}) do
    m = tostring(m)
    if cm[m] and cm[m].text and not seen[m] and #mods < MAX_MODS then seen[m] = true; mods[#mods + 1] = m end
  end
  if #mods > 0 then out.m = mods end
  local arc = tonumber(pn.arc)
  if arc and arc > 0 and arc < 2000 then out.arc = floor(arc + 0.5) end
  if out.d == 0 and not out.ca and not out.m then return nil end -- nothing to say
  return out
end

-- the phrases of one note in the order a co-driver reads them: caution, corner, length, shape, extras
function P.phrases(pn)
  local out = {}
  if not pn then return out end
  local c, types = cornerCfg(), ct()
  local function add(text, variant, cat) if text and text ~= '' then out[#out + 1] = { text = text, variant = variant, cat = cat } end end
  if pn.ca and types.caution and types.caution.levels then add(types.caution.levels[pn.ca], nil, 'caution') end
  if pn.d ~= 0 and pn.c then
    local dir = c.direction and c.direction[pn.d]
    local desc = c.descriptors and c.descriptors[pn.c]
    if desc then add(desc.text .. ' ' .. dir, nil, 'corner')
    else
      local e = intensityById(pn.c)
      if e then
        add(e.text .. ' ' .. dir .. (e.afterDirection and (' ' .. e.afterDirection) or ''), nil, 'corner')
        if pn.len then
          for _, l in ipairs(((c.numbering or {}).lengthsByIntensity or {})[pn.c] or {}) do
            if l.id == pn.len then add(l.text, nil, 'modifier') end
          end
        end
      end
    end
    local sh = pn.sh and c.shapes and c.shapes[pn.sh]
    if sh then add(sh.text, sh.variant, 'modifier') end
  end
  for _, m in ipairs(pn.m or {}) do
    local e = (types.modifiers or {})[m]
    if e then add(e.text, e.variant, 'modifier') end
  end
  return out
end

-- Chase mode reads direction only: SHARP (hairpins, square, 1, 2), plain (3, 4), HALF (5, 6), STRAIGHT (flat), plus the
-- cautions and extras; never the length, the shape or distances. The game's co-drivers recorded no "sharp", "half" or
-- "straight", so the voice says the nearest words they did record: "hard left", "left", "easy left", "keep middle".
local CHASE_CLASS = { hairpin = 'sharp', openHairpin = 'sharp', tightHairpin = 'sharp', square = 'sharp', one = 'sharp', two = 'sharp',
  three = 'plain', four = 'plain', five = 'half', six = 'half', flat = 'straight' }
P.CHASE_CLASS = CHASE_CLASS
local CHASE_SAY = { sharp = 'hard %s', plain = '%s', half = 'easy %s', straight = 'keep middle' }
local CHASE_SHOW = { sharp = 'SHARP %s', plain = '%s', half = 'HALF %s', straight = 'STRAIGHT' }

local function chaseDir(pn)
  if not pn or pn.d == 0 or not pn.c then return nil end
  local cls = CHASE_CLASS[pn.c] or 'plain'
  local dir = pn.d == -1 and 'left' or 'right'
  return cls, dir
end

function P.chasePhrases(pn)
  local out = {}
  if not pn then return out end
  local types = ct()
  if pn.ca and types.caution and types.caution.levels then out[#out + 1] = { text = types.caution.levels[pn.ca], cat = 'caution' } end
  local cls, dir = chaseDir(pn)
  if cls then out[#out + 1] = { text = CHASE_SAY[cls]:format(dir), cat = 'corner', alt = { dir } } end
  for _, m in ipairs(pn.m or {}) do
    local e = (types.modifiers or {})[m]
    if e then out[#out + 1] = { text = e.text, variant = e.variant, cat = 'modifier' } end
  end
  return out
end

-- Chase mode on the screen: "SHARP LEFT", and the cautions / extras on their own line ("CAUTION · CREST")
function P.chaseText(pn)
  if not pn then return '', '' end
  local cls, dir = chaseDir(pn)
  local main = cls and CHASE_SHOW[cls]:format(dir:upper()) or ''
  local extra, types = {}, ct()
  if pn.ca and types.caution and types.caution.levels then extra[#extra + 1] = string.upper(types.caution.levels[pn.ca] or '') end
  for _, m in ipairs(pn.m or {}) do
    local e = (types.modifiers or {})[m]
    if e and e.text then extra[#extra + 1] = string.upper(e.text) end
  end
  if main == '' and #extra > 0 then main = table.remove(extra, 1) end
  return main, table.concat(extra, ' \194\183 ')
end

-- short text for the screen: "CAUTION 3 LEFT LONG TIGHTENS DON'T CUT"
function P.text(pn)
  if not pn then return '' end
  local parts = {}
  local c = cornerCfg()
  for _, ph in ipairs(P.phrases(pn)) do
    local t = ph.text
    if ph.cat == 'corner' then
      local e = intensityById(pn.c)
      if e and e.visual and e.visual.text then t = e.visual.text .. ' ' .. (c.direction[pn.d] or '') end
    end
    parts[#parts + 1] = t
  end
  return string.upper(table.concat(parts, ' '))
end

-- the distance call after a note: a link word ("into" / "and") for close notes, else "100", "1 point 5 km"
function P.distanceCall(gap)
  P.load()
  local d = style.distance or {}
  gap = tonumber(gap)
  if not gap or gap < 0 then return nil, false end
  for _, link in ipairs(d.links or {}) do
    if gap < link.threshold then return link.text, true end
  end
  if d.max and gap > d.max then return nil, false end
  local r = d.rounding or {}
  local function round(v, to) return floor(v / to + 0.5) * to end
  local val, large
  if gap >= (r.largeThreshold or 1000) then
    val, large = round(gap, r.large or 250) / (r.largeThreshold or 1000), true
  elseif gap >= (r.mediumThreshold or 100) then
    val = round(gap, r.medium or 50)
    if val == (r.largeThreshold or 1000) then val, large = 1, true end
  else
    val = round(gap, r.small or 10)
  end
  local s = tostring(val)
  if large then
    local a, b = s:match('(%d+)%.(%d+)')
    if a then s = a .. ' ' .. ((d.units or {}).point or 'point') .. ' ' .. b:gsub('(%d)', '%1 '):gsub(' $', '') end
    s = s .. ' ' .. ((d.units or {}).large or 'km')
  end
  return s, false
end

-- tiles in the game's visual pacenote format (visualCompositor): caution, corner (with its shape as turnModifier
-- and cut advice as additionalNote), then extras that have an icon; at most 4
function P.visual(pn, distanceText, isInto)
  local tiles = {}
  if not pn then return tiles end
  local c, types = cornerCfg(), ct()
  if pn.ca and types.caution then
    local v = (types.caution.levelVisuals or {})[pn.ca] or types.caution.visual
    if v then tiles[#tiles + 1] = { type = pn.ca >= 3 and 'doubleCaution' or 'caution', colorNoteIcon = v.colorNoteIcon, colorNoteText = v.colorNoteText,
      background = { color = v.colorBg, strokeColor = v.colorStroke, opacity = 1 }, size = 2 } end
  end
  local corner = nil
  if pn.d ~= 0 and pn.c then
    local desc = c.descriptors and c.descriptors[pn.c]
    local v = (desc and desc.visual) or ((intensityById(pn.c) or {}).visual)
    if v then
      corner = { type = v.icon, turnTypeValue = v.text, colorNoteIcon = v.colorNoteIcon, colorNoteText = v.colorNoteText,
        background = { color = v.colorBg, strokeColor = v.colorStroke, opacity = 1 }, isLeft = pn.d == -1, size = 2 }
      local sh = pn.sh and c.shapes and c.shapes[pn.sh]
      if sh and sh.visual and sh.visual.icon then corner.turnModifier = sh.visual.icon end
      tiles[#tiles + 1] = corner
    end
  end
  for _, m in ipairs(pn.m or {}) do
    local v = ((types.modifiers or {})[m] or {}).visual
    if v and v.additionalNote then
      if corner and not corner.additionalNote then corner.additionalNote = v.additionalNote end
    elseif v and v.turnModifier then
      if corner and not corner.turnModifier then corner.turnModifier = v.turnModifier end
    elseif v and v.icon and #tiles < 4 then
      tiles[#tiles + 1] = { type = v.icon, colorNoteIcon = v.colorIcon, colorNoteText = v.colorNoteText,
        background = { color = v.colorBg, strokeColor = v.colorStroke, opacity = 1 }, size = 2 }
    end
  end
  if #tiles > 0 then
    tiles[1].isInto = isInto or nil
    tiles[1].intoColor = isInto and tiles[1].background and tiles[1].background.strokeColor or nil
    if distanceText then
      tiles[#tiles].distance = distanceText
      tiles[#tiles].colorDistance = (style.visualGeneral or {}).distanceColor
    end
  end
  return tiles
end

-- compact text form for GPX files: "R3 len:long sh:tightens ca:2 m:dontCut m:crest arc:48"
local SEV_CODE = { one = '1', two = '2', three = '3', four = '4', five = '5', six = '6', hairpin = 'HP', openHairpin = 'OHP', tightHairpin = 'THP', square = 'SQ', flat = 'FL' }
local CODE_SEV = {}
for k, v in pairs(SEV_CODE) do CODE_SEV[v] = k end

function P.encode(pn)
  if not pn then return nil end
  local parts = { (pn.d == -1 and 'L' or pn.d == 1 and 'R' or '-') .. (pn.d ~= 0 and SEV_CODE[pn.c] or '') }
  if pn.len then parts[#parts + 1] = 'len:' .. pn.len end
  if pn.sh then parts[#parts + 1] = 'sh:' .. pn.sh end
  if pn.ca then parts[#parts + 1] = 'ca:' .. pn.ca end
  for _, m in ipairs(pn.m or {}) do parts[#parts + 1] = 'm:' .. m end
  if pn.arc then parts[#parts + 1] = 'arc:' .. pn.arc end
  return table.concat(parts, ' ')
end

function P.decode(code)
  if type(code) ~= 'string' then return nil end
  local pn = { m = {} }
  for tok in code:gmatch('%S+') do
    local k, v = tok:match('^(%a+):(.+)$')
    if k == 'len' then pn.len = v elseif k == 'sh' then pn.sh = v elseif k == 'ca' then pn.ca = tonumber(v)
    elseif k == 'm' then pn.m[#pn.m + 1] = v elseif k == 'arc' then pn.arc = tonumber(v)
    elseif not k then
      local d, sev = tok:match('^([LR%-])(%w*)$')
      if d then pn.d = d == 'L' and -1 or d == 'R' and 1 or 0; pn.c = CODE_SEV[sev] end
    end
  end
  return P.normalize(pn)
end

-- ------------------------------------------------------------------ voices (the game's co-driver voicepacks)
local voices = nil
local voice = nil        -- { id, label, audioDir, meta = { [basename] = len }, variants = { [stem] = { basenames } }, gaps }

local function readJsonFile(p)
  if not (FS and FS.fileExists and FS:fileExists(p)) then return nil end
  local ok, d = pcall(jsonReadFile, p)
  return ok and type(d) == 'table' and d or nil
end

local PERSONA_NAMES = { dirtwheel = 'Dirtwheel', ak = 'AK', rh = 'RH' }
local function labelFor(info, id)
  local persona = tostring(info.persona or id):match('personas%.([%w_]+)%.name') or tostring(info.persona or id)
  local dialect = tostring(info.dialect or ''):match('dialects%.en%-(%u+)%.name')
  local name = PERSONA_NAMES[persona] or (persona:sub(1, 1):upper() .. persona:sub(2))
  return name .. (dialect and (' (' .. (dialect == 'GB' and 'UK' or dialect) .. ')') or '')
end

function P.scanVoices()
  local list = {}
  local ok, dirs = pcall(function() return FS:findFiles(VOICE_DIR, '*', 0, false, true) end)
  if ok and type(dirs) == 'table' then
    for _, d in ipairs(dirs) do
      local id = tostring(d):gsub('[/\\]$', ''):match('([^/\\]+)$')
      local info = id and readJsonFile(VOICE_DIR .. id .. '/voicepack.json')
      if info and info.compositorStyle == WANT_STYLE then
        local audioId = id
        if not (FS:fileExists(VOICE_DIR .. id .. '/metadata.json')) and type(info.reuseAudioFrom) == 'table' then audioId = tostring(info.reuseAudioFrom[1] or id) end
        if FS:fileExists(VOICE_DIR .. audioId .. '/metadata.json') then
          list[#list + 1] = { id = id, audioId = audioId, label = labelFor(info, id),
            gaps = { link = tonumber(info.linkWordGapMs) or 0, corner = tonumber(info.cornerGapMs) or 0, phrase = tonumber(info.phraseGapMs) or 0, note = tonumber(info.pacenoteGapMs) or 0 } }
        end
      end
    end
  end
  -- one entry per voice (newest pack of each name), sorted by name
  table.sort(list, function(a, b) if a.label ~= b.label then return a.label < b.label end return a.id > b.id end)
  local out, seen = {}, {}
  for _, v in ipairs(list) do if not seen[v.label] then seen[v.label] = true; out[#out + 1] = v end end
  voices = out
  return out
end

function P.voices() return (voices and #voices > 0) and voices or P.scanVoices() end

function P.setVoice(id)
  local list = P.voices()
  local pick = nil
  for _, v in ipairs(list) do if v.id == id then pick = v end end
  if not pick then
    for _, v in ipairs(list) do if v.label:find('Dirtwheel', 1, true) then pick = v end end
  end
  pick = pick or list[1]
  if not pick then voice = nil; return nil end
  if voice and voice.id == pick.id then return voice end
  local meta = readJsonFile(VOICE_DIR .. pick.audioId .. '/metadata.json') or {}
  local lens, variants = {}, {}
  for b, e in pairs(meta) do
    if type(b) == 'string' and b:match('%.ogg$') then
      lens[b] = tonumber(type(e) == 'table' and e.audioLen) or 1
      local stem = b:match('^(.*)_%d+%.ogg$')
      if stem then variants[stem] = variants[stem] or {}; table.insert(variants[stem], b) end
    end
  end
  for _, l in pairs(variants) do table.sort(l) end
  voice = { id = pick.id, label = pick.label, audioDir = VOICE_DIR .. pick.audioId .. '/audio/', meta = lens, variants = variants, gaps = pick.gaps }
  return voice
end

function P.voice() return voice end

-- an audio file in the voice for one phrase (exact, the asked-for variant, or any numbered variant)
local function clipFor(text, variant)
  if not voice then return nil end
  local base = 'pacenote_' .. phraseHash(text)
  if variant and voice.meta[base .. '_' .. variant .. '.ogg'] then return base .. '_' .. variant .. '.ogg' end
  if voice.meta[base .. '.ogg'] then return base .. '.ogg' end
  local list = voice.variants[base]
  if list and #list > 0 then return list[math.random(#list)] end
  return nil
end
P.clipFor = clipFor

-- ------------------------------------------------------------------ playback queue (co-driver intercom)
local queue, busyUntil, missing, channel = {}, 0, {}, nil

function P.enqueue(entries, isNoteEnd)
  if not voice then return 0 end
  local added = 0
  for i, e in ipairs(entries) do
    local b = clipFor(e.text, e.variant)
    for _, a in ipairs(not b and e.alt or {}) do b = b or clipFor(a) end -- a plainer word the voice did record
    if b then
      local gap = voice.gaps.phrase
      if e.cat == 'link' then gap = voice.gaps.link
      elseif e.cat == 'corner' and entries[i + 1] and entries[i + 1].cat == 'corner' then gap = voice.gaps.corner end
      if i == #entries and isNoteEnd ~= false then gap = voice.gaps.note end
      queue[#queue + 1] = { fname = voice.audioDir .. b, len = voice.meta[b] or 1, gap = (gap or 0) / 1000 }
      added = added + 1
    elseif not missing[e.text] then
      missing[e.text] = true
      if log then log('W', 'TreadXLGPS', 'no co-driver audio for "' .. tostring(e.text) .. '" in ' .. voice.label) end
    end
  end
  return added
end

-- system calls (countdown, false start) from the voicepack
function P.system(key)
  if not voice then return false end
  local b = 'pacenote_system_' .. key .. '_1.ogg'
  if not voice.meta[b] then return false end
  queue[#queue + 1] = { fname = voice.audioDir .. b, len = voice.meta[b], gap = 0 }
  return true
end

function P.clear()
  queue = {}
  busyUntil = 0
  if channel then pcall(function() Engine.Audio.intercomStopPacenote(channel) end); channel = nil end
end
function P.pending(now) return #queue > 0 or (now or 0) < busyUntil end
function P.queuedSeconds(now)
  local t = math.max(0, busyUntil - (now or 0))
  for _, c in ipairs(queue) do t = t + c.len + c.gap end
  return t
end

-- call every frame with a real-time clock; plays the next clip when the previous one is done
function P.update(now)
  if #queue == 0 or now < busyUntil then return end
  local c = table.remove(queue, 1)
  local ok, id = pcall(function() return Engine.Audio.intercomPlayPacenote({ filename = c.fname }) end)
  if ok then channel = type(id) == 'number' and id or nil
  else pcall(function() Engine.Audio.playOnce('AudioGui', c.fname) end) end
  busyUntil = now + math.max(0.05, c.len + c.gap)
  return c.fname
end

-- ------------------------------------------------------------------ auto pacenotes from a course line
-- Corners from the line's curvature, sized with the game's own 1-6 diameter ranges and length buckets.
local STEP = 5

local function resample(pts)
  local out, acc, i = {}, 0, 1
  if #pts < 2 then return out end
  out[1] = { x = pts[1].x, y = pts[1].y, z = pts[1].z or 0, s = 0 }
  local target = STEP
  for k = 2, #pts do
    local a, b = pts[k - 1], pts[k]
    local seg = sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2)
    while seg > 0 and acc + seg >= target do
      local t = (target - acc) / seg
      out[#out + 1] = { x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = (a.z or 0) + ((b.z or 0) - (a.z or 0)) * t, s = target }
      target = target + STEP
    end
    acc = acc + seg
  end
  return out
end

local function intensityForDiameter(dm)
  local list = intensityList()
  for _, e in ipairs(list) do
    local d = e.diameter or {}
    if (not d.min or dm >= d.min) and (not d.max or dm < d.max) then return e end
  end
  return list[#list]
end

local function lengthFor(intensityId, arc)
  for _, l in ipairs((((cornerCfg().numbering or {}).lengthsByIntensity) or {})[intensityId] or {}) do
    local r = l.arcMeters or {}
    if (not r.min or arc >= r.min) and (not r.max or arc < r.max) then return l.text and l.id or nil end
  end
  return nil
end

-- pts: course points {x, y, z}; returns { { s, x, y, z, pn }, ... } sorted by s
function P.generate(pts)
  P.load()
  local r = resample(pts or {})
  local n = #r
  local notes = {}
  if n < 6 then return notes end
  -- heading (compass, clockwise) from a central difference, then curvature per metre, lightly smoothed
  local hd = {}
  for i = 1, n do
    local a, b = r[math.max(1, i - 1)], r[math.min(n, i + 1)]
    hd[i] = atan2(b.x - a.x, b.y - a.y)
  end
  local function dh(a, b) local d = b - a; while d > pi do d = d - 2 * pi end; while d < -pi do d = d + 2 * pi end; return d end
  local k = {}
  for i = 1, n do k[i] = dh(hd[math.max(1, i - 1)], hd[math.min(n, i + 1)]) / (STEP * (math.min(n, i + 1) - math.max(1, i - 1))) end
  local ks = {}
  for i = 1, n do ks[i] = ((k[i - 1] or k[i]) + k[i] + (k[i + 1] or k[i])) / 3 end
  -- corner runs: start above 1/150 m^-1 (radius 150 m), keep going above 1/260 with the same sign
  local runs, i = {}, 2
  while i < n do
    if abs(ks[i]) > 1 / 150 then
      local sign = ks[i] > 0 and 1 or -1
      local a = i
      while a > 2 and ks[a - 1] * sign > 1 / 260 do a = a - 1 end
      local b = i
      while b < n - 1 and ks[b + 1] * sign > 1 / 260 do b = b + 1 end
      runs[#runs + 1] = { a = a, b = b, sign = sign }
      i = b + 1
    else
      i = i + 1
    end
  end
  -- merge same-direction runs split by a short straight
  local merged = {}
  for _, run in ipairs(runs) do
    local last = merged[#merged]
    if last and last.sign == run.sign and (run.a - last.b) * STEP <= 10 then last.b = run.b else merged[#merged + 1] = run end
  end
  for _, run in ipairs(merged) do
    local turn, kmax, first, last = 0, 0, 0, 0
    local cnt = run.b - run.a + 1
    for j = run.a, run.b do
      turn = turn + ks[j] * STEP
      kmax = math.max(kmax, abs(ks[j]))
      if j - run.a < cnt / 3 then first = first + abs(ks[j]) elseif run.b - j < cnt / 3 then last = last + abs(ks[j]) end
    end
    local deg = abs(turn) * 180 / pi
    local arc = cnt * STEP
    if deg >= 20 and arc >= 8 and kmax > 0 then
      local diameter = 2 / kmax
      local e = intensityForDiameter(diameter)
      local pn = { d = run.sign, c = e and e.id or 'six', arc = arc }
      if deg >= 140 and diameter < 40 then pn.c = 'hairpin'
      elseif deg >= 70 and deg <= 110 and arc <= 22 and diameter < 35 then pn.c = 'square'
      else
        pn.len = lengthFor(pn.c, arc)
        if cnt >= 4 then
          if last > first * 1.6 then pn.sh = 'tightens' elseif first > last * 1.6 then pn.sh = 'opens' end
        end
      end
      local p = r[run.a]
      notes[#notes + 1] = { s = p.s, x = p.x, y = p.y, z = p.z, pn = pn }
    end
  end
  -- crests from the height profile: the slope swings from climbing to falling within ~25 m
  for j = 4, n - 4 do
    local up = (r[j].z - r[j - 3].z) / (3 * STEP)
    local down = (r[j + 3].z - r[j].z) / (3 * STEP)
    if up > 0.04 and down < -0.04 and r[j].z >= r[j - 1].z and r[j].z >= r[j + 1].z then
      local big = up - down > 0.2
      local near = nil
      for _, nt in ipairs(notes) do
        if nt.pn.d ~= 0 and r[j].s >= nt.s - 10 and r[j].s <= nt.s + (nt.pn.arc or 20) then near = nt end
      end
      if near and not near.pn.sh then near.pn.sh = 'overCrest'
      elseif not near then
        local s0 = r[j].s - 20
        local p = r[math.max(1, j - 4)]
        notes[#notes + 1] = { s = math.max(0, s0), x = p.x, y = p.y, z = p.z, pn = { d = 0, m = { big and 'bigCrest' or 'crest' } } }
      end
    end
  end
  table.sort(notes, function(a, b) return a.s < b.s end)
  for _, nt in ipairs(notes) do nt.pn = P.normalize(nt.pn) end
  local out = {}
  for _, nt in ipairs(notes) do if nt.pn then out[#out + 1] = nt end end
  return out
end

-- for the UI: what the builder can offer (ids + labels), straight from the style
function P.catalog()
  P.load()
  local c, types = cornerCfg(), ct()
  local sev = {}
  for _, e in ipairs(intensityList()) do sev[#sev + 1] = { id = e.id, label = (e.visual and e.visual.text) or e.text, vis = P.visual({ d = 1, c = e.id }) } end
  for _, id in ipairs({ 'hairpin', 'square', 'flat' }) do
    if c.descriptors and c.descriptors[id] then sev[#sev + 1] = { id = id, label = (c.descriptors[id].visual or {}).text or id, vis = P.visual({ d = 1, c = id }) } end
  end
  local shapes = {}
  for _, id in ipairs({ 'opens', 'tightens', 'tightensDown', 'overCrest', 'opensOverCrest', 'tightensOverCrest', 'opensAndTightens', 'tightensAndOpens' }) do
    if c.shapes and c.shapes[id] then shapes[#shapes + 1] = { id = id, label = c.shapes[id].text } end
  end
  local mods = {}
  for _, id in ipairs({ 'dontCut', 'cut', 'keepIn', 'keepLeft', 'keepRight', 'keepMiddle', 'crest', 'bigCrest', 'jump', 'bigJump', 'overJump', 'bump', 'bumpy',
    'dip', 'badDip', 'watersplash', 'overBridge', 'narrowBridge', 'narrows', 'atJunction', 'brake', 'slowing', 'slippy', 'ontoGravel', 'ontoTarmac', 'ontoMud', 'ontoIce', 'finish', 'toStop' }) do
    local e = (types.modifiers or {})[id]
    if e and e.text then mods[#mods + 1] = { id = id, label = e.text } end
  end
  local lengths = {}
  for _, l in ipairs(((c.numbering or {}).lengthsByIntensity or {}).three or {}) do
    if l.text then lengths[#lengths + 1] = { id = l.id, label = l.text } end
  end
  local cautions = {}
  for lvl, t in ipairs((types.caution or {}).levels or {}) do cautions[#cautions + 1] = { id = lvl, label = t } end
  return { source = styleSource, severities = sev, shapes = shapes, modifiers = mods, lengths = lengths, cautions = cautions }
end

-- for tests
P._reset = function() style, styleSource, voices, voice, queue, busyUntil, missing, channel = nil, 'none', nil, nil, {}, 0, {}, nil end

return P

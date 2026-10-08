-- Runs when the mod is mounted (single-player mod load or BeamMP client-mod download).
load("TreadXLGPS")                              -- lua/ge/extensions/TreadXLGPS.lua
setExtensionUnloadMode("TreadXLGPS", "manual")  -- keep it (and the loaded course) across level loads

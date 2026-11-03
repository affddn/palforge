-- Sets an online player's party on a Windows (Wine) Palworld server. palctl writes one request line to
-- request.txt; this mod applies it on the game thread and appends the outcome to result.txt.
-- A request is "<request id> <player ID> <Pal ID>...", each ID as 32 hex digits without dashes.
local folder = "Z:/palworld/palforge/loadout/"

-- FGuid's A to D are reflected as int32, so values from 0x80000000 up are negative.
local function guid(hex)
  local parts = {}

  for index = 0, 3 do
    local value = tonumber(hex:sub(index * 8 + 1, index * 8 + 8), 16)

    if value >= 0x80000000 then
      value = value - 0x100000000
    end

    parts[index + 1] = value
  end

  return { A = parts[1], B = parts[2], C = parts[3], D = parts[4] }
end

local function sameGuid(left, right)
  return left.A == right.A and left.B == right.B and left.C == right.C and left.D == right.D
end

local function controllerOf(player)
  for _, controller in ipairs(FindAllOf("PalPlayerController") or {}) do
    local state = controller:IsValid() and controller.PlayerState

    if state and state:IsValid() and sameGuid(state.PlayerUId, player) then
      return controller
    end
  end
end

-- PalUtility:IsInArenaByCharacter, called on its class default object. Nil when the game cannot answer.
local function inArena(controller)
  local utility = StaticFindObject("/Script/Pal.Default__PalUtility")
  local character = controller.Pawn

  if utility == nil or not utility:IsValid() or character == nil or not character:IsValid() then
    return nil
  end

  return utility:IsInArenaByCharacter(character)
end

local function apply(line)
  local id, player, rest = line:match("^(%S+)%s+(%x+)%s*(.*)$")

  if id == nil or #player ~= 32 then
    return "? error the request is not readable"
  end

  local pals = {}

  for pal in rest:gmatch("%S+") do
    if not pal:match("^%x+$") or #pal ~= 32 then
      return id .. " error " .. pal .. " is not a Pal ID"
    end

    pals[#pals + 1] = { PlayerUId = guid(string.rep("0", 32)), InstanceId = guid(pal) }
  end

  if #pals == 0 or #pals > 5 then
    return id .. " error a party holds 1 to 5 Pals"
  end

  local uid = guid(player)
  local controller = controllerOf(uid)

  if controller == nil then
    return id .. " error the player is not online"
  end

  -- A party change during an Arena match would change the match, so it waits until the player has left it.
  local arena = inArena(controller)

  if arena == nil then
    return id .. " error cannot tell whether the player is in an Arena match"
  end

  if arena then
    return id .. " error the player is in an Arena match"
  end

  controller.Transmitter.Character:RequestApplyPalLoadoutData_ToServer(uid, pals)

  return id .. " ok"
end

local function report(line)
  local file = io.open(folder .. "result.txt", "a")

  if file == nil then
    print("[palforge] cannot write " .. folder .. "result.txt: " .. line .. "\n")
    return
  end

  file:write(line .. "\n")
  file:close()
end

LoopAsync(2000, function()
  local file = io.open(folder .. "request.txt", "r")

  if file == nil then
    return false
  end

  local line = file:read("*l") or ""
  file:close()

  -- A request that stays in place would be applied again every 2 seconds, so it is applied only once it is gone.
  local removed, reason = os.remove(folder .. "request.txt")

  if not removed then
    print("[palforge] ignored a request it cannot remove: " .. tostring(reason) .. "\n")
    return false
  end

  ExecuteInGameThread(function()
    local ok, result = pcall(apply, line)
    report(ok and result or ("? error " .. tostring(result)))
  end)

  return false
end)

print("[palforge] PalforgeLoadout reads " .. folder .. "request.txt\n")

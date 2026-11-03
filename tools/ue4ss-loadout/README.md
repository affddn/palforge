# PalforgeLoadout (experimental)

A UE4SS Lua mod that sets an online player's party without a restart. It works only on a Windows Palworld server, for example `thijsvanloef/palworld-server-docker:wine` with UE4SS. The Linux server cannot load it.

> [!WARNING]
> This is an experiment ([#1](https://github.com/affddn/palforge/issues/1)). It is not known yet if an unmodded PS5 can join a 1.0.x server with UE4SS. UE4SS can crash a server under load. Use a staging server, not a production server.

## How it works

1. `palctl party set <server> <player> <pal...>` reads the saves (as `palctl save show` does) and refuses Pals that are not in the player's party or Palbox.
2. palctl writes one line to `/palworld/palforge/loadout/request.txt` in the container: a request ID, the player ID and the Pal IDs, as 32 hex digits each.
3. Every 2 seconds the mod reads the file. On the game thread, it finds the player's `PalPlayerController`, refuses a player in an Arena match (`PalUtility:IsInArenaByCharacter`), and calls `Transmitter.Character:RequestApplyPalLoadoutData_ToServer(PlayerUId, LoadoutPalIds)`. This is the function that the game uses for party loadouts. The mod appends `<request ID> ok` or `<request ID> error <reason>` to `result.txt`.
4. palctl makes the server save. The saved party must hold the requested Pals.

palforge found the function on game build 25247047 with a UE4SS object scan of the Windows server:

```text
Function /Script/Pal.PalNetworkCharacterComponent:RequestApplyPalLoadoutData_ToServer
  StructProperty PlayerUId ScriptStruct /Script/CoreUObject.Guid
  ArrayProperty LoadoutPalIds of StructProperty (PalInstanceID)
PalNetworkTransmitter.Character: PalNetworkCharacterComponent
Function /Script/Pal.PalUtility:IsInArenaByCharacter
  ObjectProperty Character
  BoolProperty ReturnValue
```

## Install

Copy `PalforgeLoadout/` into `Pal/Binaries/Win64/ue4ss/Mods/` of the server, or into `Mods/NativeMods/PalforgeLoadout/Mods/` when the image installs UE4SS mods at start. The UE4SS log shows `[palforge] PalforgeLoadout reads Z:/palworld/palforge/loadout/request.txt` when the mod is loaded.

## Open items

- A PS5 player joins the staging server and gets a new party.
- A soak test with players online.

"""Reads and edits a stopped Palworld world with palsav. palctl runs it in a container; see README.md."""

import bisect
import collections
import copy
import json
import logging
import pathlib
import re
import sys

# palsav logs every compression and decompression at INFO.
logging.disable(logging.INFO)

from palsav.archive import UUID  # noqa: E402
from palsav.core import compress_gvas_to_sav, decompress_sav_to_gvas  # noqa: E402
from palsav.gvas import GvasFile  # noqa: E402
from palsav.json_tools import CustomEncoder  # noqa: E402
from palsav.paltypes import PALWORLD_CUSTOM_PROPERTIES, PALWORLD_TYPE_HINTS  # noqa: E402

ZERO = "00000000-0000-0000-0000-000000000000"

# The game only loads player saves named by the player's GUID in upper case.
PLAYER_FILE = re.compile(r"^[0-9A-F]{32}(_dps)?\.sav$")

# A new or grown stack stays at or below this unless the world already holds a bigger stack of the item, like Money.
STACK_LIMIT = 9999


class Refused(Exception):
    pass


class SaveFile:
    def __init__(self, path: pathlib.Path):
        self.raw, self.save_type = decompress_sav_to_gvas(path.read_bytes())
        self.gvas = GvasFile.read(self.raw, PALWORLD_TYPE_HINTS, PALWORLD_CUSTOM_PROPERTIES, allow_nan=True)

        # Anything palsav does not understand would be lost on write, so an exact round trip is required.
        if self.gvas.write(PALWORLD_CUSTOM_PROPERTIES) != self.raw:
            raise Refused(f"{path.name}: palsav does not write this file back byte for byte; the save format may have changed")

    def encode(self) -> bytes:
        return compress_gvas_to_sav(self.gvas.write(PALWORLD_CUSTOM_PROPERTIES), self.save_type)


def params(entry):
    return entry["value"]["RawData"]["value"]["object"]["SaveParameter"]["value"]


def field(values, key, default=None):
    found = values.get(key)
    return default if found is None else found["value"]


def container_id(prop) -> str:
    return str(prop["value"]["ID"]["value"])


# A Pal on an expedition stays listed in its Palbox, but the game will not move it until it is back.
def on_expedition(values) -> bool:
    return str(field(values, "MapObjectConcreteInstanceIdAssignedToExpedition", ZERO)) != ZERO


def number(value):
    # Byte properties such as Level hold {"type": "None", "value": n}.
    return value["value"] if isinstance(value, dict) else value


def guid(value: str) -> UUID:
    return UUID.from_str(value)


def player_file(uid: str) -> str:
    return f"Players/{uid.replace('-', '').upper()}.sav"


# Dimensional Pal Storage: Players/<UID>_dps.sav, a fixed array of entries. An entry holds every field of a Pal, and an
# empty entry has CharacterID None. Level.sav saves only the fields of a Pal that differ from an empty entry.
def dps_file(uid: str) -> str:
    return player_file(uid).replace(".sav", "_dps.sav")


def dps_entries(save: SaveFile):
    return save.gvas.properties["SaveParameterArray"]["value"]["values"]


def dps_pal(entry) -> str:
    return str(entry["InstanceId"]["value"]["InstanceId"]["value"])


def is_free(entry) -> bool:
    return entry["SaveParameter"]["value"]["CharacterID"]["value"] == "None"


def full_params(values, empty):
    return {key: copy.deepcopy(values[key] if key in values else default) for key, default in empty.items()}


def level_params(values, empty):
    return {key: copy.deepcopy(value) for key, value in values.items() if key == "SlotId" or not same(value, empty[key])}


def dynamic_id(item) -> str:
    return str(item["dynamic_id"]["local_id_in_created_world"])


def record_id(record) -> str:
    raw = record["RawData"]["value"]
    return str(raw["id"]["local_id_in_created_world"]) if isinstance(raw, dict) and "id" in raw else ""


def stack(raw) -> str:
    return "empty" if raw is None else f"{raw['item']['static_id']} x{raw['count']}"


# A Pal in DPS can keep the expedition it was on before it went there, but it is not away.
def summary(slot: int, pal: str, values, stored=False):
    return {
        "slot": slot,
        "id": pal,
        "species": field(values, "CharacterID"),
        "level": number(field(values, "Level", 1)),
        "nickname": field(values, "NickName") or None,
        "expedition": not stored and on_expedition(values),
    }


class World:
    def __init__(self, root: pathlib.Path):
        names = sorted(path.name for path in (root / "Players").glob("*.sav"))
        misnamed = [name for name in names if not PLAYER_FILE.match(name)]

        if misnamed:
            raise Refused(f"player saves must be named by an upper-case GUID: {', '.join(misnamed)}")

        self.root = root
        self.level = SaveFile(root / "Level.sav")
        self.players = {}

        for name in names:
            if name.endswith("_dps.sav"):
                continue

            save = SaveFile(root / "Players" / name)
            uid = str(save.gvas.properties["SaveData"]["value"]["PlayerUId"]["value"])

            if uid.replace("-", "").upper() != name[:32]:
                raise Refused(f"Players/{name} holds player {uid}")

            self.players[uid] = save

        # Unpacked, a DPS file is about 70 MB, so each is read only when an operation needs it.
        self.dps = {}
        self.empty = None
        self.changed = set()
        self.expect = []
        self.touched = {key: set() for key in ENTRY_NAMES}
        self.dps_touched = collections.defaultdict(set)
        # Pals that moved between Level.sav and DPS, with the file each came from and the file it is in now.
        self.moved = {}

    @property
    def data(self):
        return self.level.gvas.properties["worldSaveData"]["value"]

    def characters(self):
        return {str(entry["key"]["InstanceId"]["value"]): entry for entry in self.data["CharacterSaveParameterMap"]["value"]}

    def character_containers(self):
        return {str(entry["key"]["ID"]["value"]): entry for entry in self.data["CharacterContainerSaveData"]["value"]}

    def item_containers(self):
        return {str(entry["key"]["ID"]["value"]): entry["value"] for entry in self.data["ItemContainerSaveData"]["value"]}

    def player_names(self):
        return {
            str(entry["key"]["PlayerUId"]["value"]): field(params(entry), "NickName", "")
            for entry in self.data["CharacterSaveParameterMap"]["value"]
            if field(params(entry), "IsPlayer")
        }

    def player(self, ref: str) -> str:
        matches = [uid for uid, name in self.player_names().items() if ref in (uid, name) and uid in self.players]

        if len(matches) != 1:
            raise Refused(f"{'no' if not matches else 'more than one'} player with a save file is called {ref}")

        return matches[0]

    def player_data(self, uid: str):
        return self.players[uid].gvas.properties["SaveData"]["value"]

    def party_and_palbox(self, uid: str):
        data = self.player_data(uid)
        return container_id(data["OtomoCharacterContainerId"]), container_id(data["PalStorageContainerId"])

    def guild(self, uid: str):
        for group in self.data["GroupSaveDataMap"]["value"]:
            if any(str(player["player_uid"]) == uid for player in group["value"]["RawData"]["value"].get("players", [])):
                return group

        raise Refused(f"{self.player_names().get(uid, uid)} is in no guild")

    def dps_save(self, uid: str):
        if uid not in self.dps:
            path = self.root / dps_file(uid)

            if not path.exists():
                return None

            self.dps[uid] = SaveFile(path)

            if self.empty is None:
                self.empty = next((copy.deepcopy(entry) for entry in dps_entries(self.dps[uid]) if is_free(entry)), None)

        return self.dps[uid]

    # The (player, entry) pairs that hold a Pal in DPS. A file that does not hold the Pal's GUID at all is not parsed.
    def in_dps(self, pal_id: str):
        needle = guid(pal_id).raw_bytes
        found = []

        for uid in self.players:
            path = self.root / dps_file(uid)

            if uid not in self.dps and (not path.exists() or needle not in decompress_sav_to_gvas(path.read_bytes())[0]):
                continue

            entries = dps_entries(self.dps_save(uid))
            found += [(uid, index) for index, entry in enumerate(entries) if not is_free(entry) and dps_pal(entry) == pal_id]

        return found

    # Level.sav as the operations so far left it.
    def level_bytes(self) -> bytes:
        return self.level.gvas.write(PALWORLD_CUSTOM_PROPERTIES) if "Level.sav" in self.changed else self.level.raw

    def describe(self, pal_id: str, values=None) -> str:
        values = params(self.characters()[pal_id]) if values is None else values
        nickname = field(values, "NickName")
        name = f"{field(values, 'CharacterID')} level {number(field(values, 'Level', 1))}"
        return f"{nickname} ({name}, {pal_id})" if nickname else f"{name} ({pal_id})"

    def pals_in(self, cid: str):
        slots = self.character_containers()[cid]["value"]["Slots"]["value"]["values"]
        return {str(slot["RawData"]["value"]["instance_id"]): slot["SlotIndex"]["value"] for slot in slots if str(slot["RawData"]["value"]["instance_id"]) != ZERO}

    def free_slot(self, uid: str, to: str, slot):
        party, palbox = self.party_and_palbox(uid)
        target_id = party if to == "party" else palbox
        used = set(self.pals_in(target_id).values())
        free = [index for index in range(self.character_containers()[target_id]["value"]["SlotNum"]["value"]) if index not in used]
        index = free[0] if slot is None and free else slot

        if index not in free:
            raise Refused(f"{self.player_names().get(uid, uid)}'s {to} has no free slot{'' if slot is None else f' {slot}'}")

        return target_id, index

    # Moves one of a player's Pals between their party, Palbox and Dimensional Pal Storage, into `slot` or the first
    # free slot.
    def move_pal(self, pal_id: str, to: str, slot=None) -> str:
        entry = self.characters().get(pal_id)

        if entry is None:
            stored = self.in_dps(pal_id)

            if len(stored) > 1:
                raise Refused(f"Pal {pal_id} is in {len(stored)} DPS entries")

            if stored and to == "dps":
                uid, index = stored[0]
                raise Refused(f"{self.describe(pal_id, dps_entries(self.dps[uid])[index]['SaveParameter']['value'])} is already in Dimensional Pal Storage")

            if stored:
                return self.withdraw_pal(pal_id, to, slot, *stored[0])

        if entry is None or field(params(entry), "IsPlayer"):
            raise Refused(f"there is no Pal {pal_id}")

        values = params(entry)
        owner = str(field(values, "OwnerPlayerUId", ZERO))

        if owner not in self.players:
            raise Refused(f"{self.describe(pal_id)} has no owner with a player save")

        party, palbox = self.party_and_palbox(owner)
        source_id = container_id(values["SlotId"]["value"]["ContainerId"])
        owner_name = self.player_names().get(owner, owner)

        if source_id not in (party, palbox):
            raise Refused(f"{self.describe(pal_id)} is not in {owner_name}'s party or Palbox; it may be working at a base")

        if on_expedition(values):
            raise Refused(f"{self.describe(pal_id)} is on an expedition")

        if to == "dps":
            return self.store_pal(pal_id, owner, source_id, slot)

        target_id = party if to == "party" else palbox

        if source_id == target_id:
            raise Refused(f"{self.describe(pal_id)} is already in {owner_name}'s {to}")

        containers = self.character_containers()
        source = containers[source_id]["value"]["Slots"]["value"]["values"]
        held = [s for s in source if str(s["RawData"]["value"]["instance_id"]) == pal_id]

        if len(held) != 1:
            raise Refused(f"{self.describe(pal_id)} is listed {len(held)} times in its container")

        target_id, index = self.free_slot(owner, to, slot)
        target = containers[target_id]["value"]
        moved = held[0]
        source.remove(moved)
        moved["SlotIndex"]["value"] = index

        # Older saves list empty slots too; an empty listing at the target index is replaced.
        slots = target["Slots"]["value"]["values"]
        slots[:] = [s for s in slots if s["SlotIndex"]["value"] != index]
        slots.insert(bisect.bisect([s["SlotIndex"]["value"] for s in slots], index), moved)

        slot_id = values["SlotId"]["value"]
        slot_id["ContainerId"]["value"]["ID"]["value"] = containers[target_id]["key"]["ID"]["value"]
        slot_id["SlotIndex"]["value"] = index

        self.changed.add("Level.sav")
        self.touched["CharacterSaveParameterMap"].add(pal_id)
        self.touched["CharacterContainerSaveData"] |= {source_id, target_id}
        self.expect.append({"kind": "pal", "pal": pal_id, "container": target_id, "slot": index})
        return f"Moved {self.describe(pal_id)} to {owner_name}'s {to}, slot {index}"

    # As the game does it: Level.sav loses the Pal, its container slot and its guild handle, and the DPS entry gets every
    # field of the Pal, the old SlotId too.
    def store_pal(self, pal_id: str, owner: str, source_id: str, slot) -> str:
        owner_name = self.player_names().get(owner, owner)
        description = self.describe(pal_id)
        save = self.dps_save(owner)

        if save is None:
            raise Refused(f"{owner_name} has no Dimensional Pal Storage file; the game writes it once they have used the storage")

        entries = dps_entries(save)
        free = [index for index, entry in enumerate(entries) if is_free(entry)]
        index = free[0] if slot is None and free else slot

        if index not in free:
            raise Refused(f"{owner_name}'s Dimensional Pal Storage has no free entry{'' if slot is None else f' {slot}'}")

        values = params(self.characters()[pal_id])
        empty = self.empty["SaveParameter"]["value"]
        unknown = [key for key in values if key not in empty]

        if unknown:
            raise Refused(f"{description} has fields that Dimensional Pal Storage has no place for: {', '.join(unknown)}")

        # A reference that the move does not remove, such as an expedition's, would point to a Pal that is gone.
        containers = self.data["CharacterContainerSaveData"]["value"]
        holders = [slots for slots in (c["value"]["Slots"]["value"]["values"] for c in containers) if any(str(s["RawData"]["value"]["instance_id"]) == pal_id for s in slots)]
        groups = {str(g["key"]): g["value"]["RawData"]["value"]["individual_character_handle_ids"] for g in self.data["GroupSaveDataMap"]["value"] if "individual_character_handle_ids" in g["value"]["RawData"]["value"]}
        groups = {group: handles for group, handles in groups.items() if any(str(h["instance_id"]) == pal_id for h in handles)}

        if self.level_bytes().count(guid(pal_id).raw_bytes) != 1 + len(holders) + len(groups):
            raise Refused(f"{description} is referenced elsewhere in Level.sav, for example by an expedition; move it in the game instead")

        entry = entries[index]
        entry["SaveParameter"]["value"] = full_params(values, empty)
        entry["InstanceId"]["value"]["InstanceId"]["value"] = guid(pal_id)

        # The game lists the Pals it put in DPS in this set, and takes a Pal out when it leaves DPS.
        if "InLockerCharacterInstanceIDArray" in self.data:
            self.data["InLockerCharacterInstanceIDArray"]["value"].append(copy.deepcopy(entry["InstanceId"]["value"]))
            self.touched["InLockerCharacterInstanceIDArray"].add(pal_id)

        characters = self.data["CharacterSaveParameterMap"]["value"]
        characters[:] = [c for c in characters if str(c["key"]["InstanceId"]["value"]) != pal_id]

        for slots in holders:
            slots[:] = [s for s in slots if str(s["RawData"]["value"]["instance_id"]) != pal_id]

        for handles in groups.values():
            handles[:] = [h for h in handles if str(h["instance_id"]) != pal_id]

        self.changed |= {"Level.sav", dps_file(owner)}
        self.touched["CharacterSaveParameterMap"].add(pal_id)
        self.touched["CharacterContainerSaveData"].add(source_id)
        self.touched["GroupSaveDataMap"] |= groups.keys()
        self.dps_touched[dps_file(owner)].add(index)
        self.moved.setdefault(pal_id, {"from": "Level.sav"})["to"] = dps_file(owner)
        self.expect.append({"kind": "dps", "pal": pal_id, "player": owner})
        return f"Moved {description} to {owner_name}'s Dimensional Pal Storage, entry {index}"

    # Level.sav gets the Pal with the fields that differ from an empty entry, a container slot and a handle in the
    # owner's guild, and the DPS entry becomes empty.
    def withdraw_pal(self, pal_id: str, to: str, slot, uid: str, index: int) -> str:
        save = self.dps[uid]
        values = dps_entries(save)[index]["SaveParameter"]["value"]
        description = self.describe(pal_id, values)
        owner_name = self.player_names().get(uid, uid)

        if str(field(values, "OwnerPlayerUId", ZERO)) != uid:
            raise Refused(f"{description} is in {owner_name}'s Dimensional Pal Storage but belongs to another player")

        if self.empty is None:
            raise Refused(f"{owner_name}'s Dimensional Pal Storage has no empty entry to copy the save format from")

        target_id, slot_index = self.free_slot(uid, to, slot)
        guild = self.guild(uid)
        pals = [c for c in self.data["CharacterSaveParameterMap"]["value"] if not field(params(c), "IsPlayer")]
        model = next((c for c in pals if str(c["value"]["RawData"]["value"]["group_id"]) == str(guild["key"])), pals[0] if pals else None)
        containers = self.character_containers()
        listed = [s for c in containers.values() for s in c["value"]["Slots"]["value"]["values"] if str(s["RawData"]["value"]["player_uid"]) == ZERO]

        if model is None or not listed:
            raise Refused("Level.sav holds no Pal in a container to copy the save format from")

        entry = copy.deepcopy(model)
        entry["key"]["PlayerUId"]["value"] = guid(ZERO)
        entry["key"]["InstanceId"]["value"] = guid(pal_id)
        entry["key"]["DebugName"]["value"] = ""
        raw = entry["value"]["RawData"]["value"]
        raw["group_id"] = guid(str(guild["key"]))
        raw["object"]["SaveParameter"]["value"] = level_params(values, self.empty["SaveParameter"]["value"])
        slot_id = params(entry)["SlotId"]["value"]
        slot_id["ContainerId"]["value"]["ID"]["value"] = guid(target_id)
        slot_id["SlotIndex"]["value"] = slot_index
        self.data["CharacterSaveParameterMap"]["value"].append(entry)

        held = copy.deepcopy(listed[0])
        held["SlotIndex"]["value"] = slot_index
        held["RawData"]["value"]["instance_id"] = guid(pal_id)
        held["RawData"]["value"]["permission_tribe_id"] = 0
        slots = containers[target_id]["value"]["Slots"]["value"]["values"]
        slots[:] = [s for s in slots if s["SlotIndex"]["value"] != slot_index]
        slots.insert(bisect.bisect([s["SlotIndex"]["value"] for s in slots], slot_index), held)

        handles = guild["value"]["RawData"]["value"]["individual_character_handle_ids"]

        if not any(str(h["instance_id"]) == pal_id for h in handles):
            handles.append({"guid": guid(ZERO), "instance_id": guid(pal_id)})
            self.touched["GroupSaveDataMap"].add(str(guild["key"]))

        dps_entries(save)[index] = copy.deepcopy(self.empty)
        locker = self.data.get("InLockerCharacterInstanceIDArray", {"value": []})["value"]

        if any(str(listed["InstanceId"]["value"]) == pal_id for listed in locker):
            locker[:] = [listed for listed in locker if str(listed["InstanceId"]["value"]) != pal_id]
            self.touched["InLockerCharacterInstanceIDArray"].add(pal_id)

        self.changed |= {"Level.sav", dps_file(uid)}
        self.touched["CharacterSaveParameterMap"].add(pal_id)
        self.touched["CharacterContainerSaveData"].add(target_id)
        self.dps_touched[dps_file(uid)].add(index)
        self.moved.setdefault(pal_id, {"from": dps_file(uid)})["to"] = "Level.sav"
        self.expect.append({"kind": "pal", "pal": pal_id, "container": target_id, "slot": slot_index, "dps": uid})
        return f"Moved {description} from {owner_name}'s Dimensional Pal Storage, entry {index}, to their {to}, slot {slot_index}"

    # The player's party becomes exactly `pals`. Pals already in the party keep their slots.
    def set_party(self, ref: str, pals) -> list:
        uid = self.player(ref)
        party, _ = self.party_and_palbox(uid)
        size = self.character_containers()[party]["value"]["SlotNum"]["value"]

        if len(pals) > size or len(set(pals)) != len(pals):
            raise Refused(f"a party holds up to {size} different Pals")

        current = self.pals_in(party)
        changes = [self.move_pal(pal, "palbox") for pal in current if pal not in pals]
        changes += [self.move_pal(pal, "party") for pal in pals if pal not in current]
        return changes or [f"{self.player_names()[uid]}'s party already holds those Pals"]

    def plain_stacks(self):
        stacks = collections.defaultdict(int)

        for container in self.item_containers().values():
            for slot in container["Slots"]["value"]["values"]:
                item = slot["RawData"]["value"]["item"]

                if dynamic_id(item) == ZERO:
                    stacks[item["static_id"]] = max(stacks[item["static_id"]], slot["RawData"]["value"]["count"])

        return stacks

    # Adds `count` of a stackable item to the player's inventory. Items with their own state (weapons, armor, eggs)
    # are refused: they need a dynamic item record.
    def give_item(self, ref: str, item: str, count: int) -> str:
        uid = self.player(ref)
        name = self.player_names()[uid]
        stacks = self.plain_stacks()

        if item not in stacks:
            raise Refused(f"{item} is not held anywhere in this world as a plain stack, so it may need its own item state or be misspelled")

        limit = max(STACK_LIMIT, stacks[item])
        inventory_id = container_id(self.player_data(uid)["InventoryInfo"]["value"]["CommonContainerId"])
        inventory = self.item_containers()[inventory_id]
        slots = inventory["Slots"]["value"]["values"]

        for slot in slots:
            raw = slot["RawData"]["value"]

            if raw["item"]["static_id"] == item and dynamic_id(raw["item"]) == ZERO and raw["count"] + count <= limit:
                raw["count"] += count
                self.changed.add("Level.sav")
                self.touched["ItemContainerSaveData"].add(inventory_id)
                self.expect.append({"kind": "item", "container": inventory_id, "slot": raw["slot_index"], "item": item, "count": raw["count"]})
                return f"Gave {name} {count} {item}; the stack in inventory slot {raw['slot_index']} now holds {raw['count']}"

        used = {slot["RawData"]["value"]["slot_index"] for slot in slots}
        free = [index for index in range(inventory["SlotNum"]["value"]) if index not in used]

        if not free or count > limit:
            raise Refused(f"{name}'s inventory has no free slot for {count} {item}")

        template = next(
            slot
            for container in self.item_containers().values()
            for slot in container["Slots"]["value"]["values"]
            if slot["RawData"]["value"]["item"]["static_id"] == item and dynamic_id(slot["RawData"]["value"]["item"]) == ZERO
        )

        added = copy.deepcopy(template)
        added["RawData"]["value"]["slot_index"] = free[0]
        added["RawData"]["value"]["count"] = count
        slots.insert(bisect.bisect([slot["RawData"]["value"]["slot_index"] for slot in slots], free[0]), added)

        self.changed.add("Level.sav")
        self.touched["ItemContainerSaveData"].add(inventory_id)
        self.expect.append({"kind": "item", "container": inventory_id, "slot": free[0], "item": item, "count": count})
        return f"Gave {name} {count} {item} in inventory slot {free[0]}"

    # Puts back an item container's slots as an older Level.sav holds them. An item with its own state (a weapon, armor,
    # an egg) comes back with its dynamic item record from that save; it is refused if the save has no record for it,
    # or if the item is now somewhere else in the world, since putting it back would duplicate it.
    def restore_container(self, cid: str, source: str) -> list:
        container = self.item_containers().get(cid)

        if container is None:
            raise Refused(f"there is no item container {cid}")

        if not pathlib.Path(source).is_file():
            raise Refused(f"there is no older save {source}")

        older = SaveFile(pathlib.Path(source))

        if not same(older.gvas.header.dump(), self.level.gvas.header.dump()):
            raise Refused("the older save was written by another version of the game")

        world = older.gvas.properties["worldSaveData"]["value"]
        old = next((entry["value"] for entry in world["ItemContainerSaveData"]["value"] if str(entry["key"]["ID"]["value"]) == cid), None)

        if old is None:
            raise Refused(f"the older save has no item container {cid}")

        restored = copy.deepcopy(old["Slots"]["value"]["values"])
        wanted = {dynamic_id(slot["RawData"]["value"]["item"]) for slot in restored} - {ZERO}
        records = {record_id(record): copy.deepcopy(record) for record in world["DynamicItemSaveData"]["value"]["values"] if record_id(record) in wanted}
        del older, world, old

        current = container["Slots"]["value"]["values"]
        size = container["SlotNum"]["value"]
        stacks = [{slot["RawData"]["value"]["slot_index"]: slot["RawData"]["value"] for slot in slots} for slots in (current, restored)]
        changed =[index for index in sorted(stacks[0].keys() | stacks[1].keys()) if not same(stacks[0].get(index), stacks[1].get(index))]

        if not changed:
            return [f"Item container {cid} already holds what the older save holds"]

        if any(index >= size for index in stacks[1]):
            raise Refused(f"item container {cid} now has {size} slots, so slot {max(stacks[1])} cannot be put back")

        # A dynamic item keeps the record the world has for it; a record the world lost comes from the older save.
        stored = self.data["DynamicItemSaveData"]["value"]["values"]
        kept = collections.Counter(record_id(record) for record in stored)
        added = {item for item in wanted if not kept[item]}

        if wanted:
            level = self.level_bytes()
            here = collections.Counter(dynamic_id(slot["RawData"]["value"]["item"]) for slot in current)

            for index, raw in sorted(stacks[1].items()):
                item = dynamic_id(raw["item"])

                if item in added and item not in records:
                    raise Refused(f"slot {index} held {raw['item']['static_id']}, whose dynamic item record neither the older save nor this world has")

                if item in wanted and level.count(guid(item).raw_bytes) > kept[item] + here[item]:
                    raise Refused(f"the {raw['item']['static_id']} of slot {index} is now elsewhere in the world; putting it back would duplicate it")

        stored += [records[item] for item in sorted(added)]
        self.touched["DynamicItemSaveData"] |= added
        current[:] = restored

        self.changed.add("Level.sav")
        self.touched["ItemContainerSaveData"].add(cid)
        self.expect.append({
            "kind": "container",
            "container": cid,
            "items": [{"slot": index, "item": raw["item"]["static_id"], "dynamic": dynamic_id(raw["item"])} for index, raw in sorted(stacks[1].items())],
        })
        def line(index):
            before, after = stack(stacks[0].get(index)), stack(stacks[1].get(index))
            record = " and its item record" if index in stacks[1] and dynamic_id(stacks[1][index]["item"]) in added else ""
            # Food also saves how fresh it is.
            return f"  slot {index}: {before}, with the item state of the older save" if before == after else f"  slot {index}: {before} -> {after}{record}"

        return [f"Restored item container {cid}:"] + [line(index) for index in changed]

    # Broken references a save edit could cause. Only new ones fail an edit; a world may already have some.
    def violations(self):
        found = set()
        characters = self.characters()
        counts = collections.Counter(str(entry["key"]["InstanceId"]["value"]) for entry in self.data["CharacterSaveParameterMap"]["value"])
        found |= {f"character {pal} is saved {n} times" for pal, n in counts.items() if n > 1}
        placed = collections.defaultdict(list)

        for cid, entry in self.character_containers().items():
            size = entry["value"]["SlotNum"]["value"]
            uses = collections.Counter()

            for slot in entry["value"]["Slots"]["value"]["values"]:
                index = slot["SlotIndex"]["value"]
                pal = str(slot["RawData"]["value"]["instance_id"])

                if pal == ZERO:
                    continue

                uses[index] += 1
                placed[pal].append((cid, index))

                if not 0 <= index < size:
                    found.add(f"container {cid} lists slot {index} of {size}")

                if pal not in characters:
                    found.add(f"container {cid} slot {index} holds missing character {pal}")

            found |= {f"container {cid} slot {index} holds {n} Pals" for index, n in uses.items() if n > 1}

        found |= {f"character {pal} is listed in {len(where)} slots" for pal, where in placed.items() if len(where) > 1}

        for pal, entry in characters.items():
            slot_id = params(entry).get("SlotId")

            if slot_id is None or field(params(entry), "IsPlayer"):
                continue

            where = (container_id(slot_id["value"]["ContainerId"]), slot_id["value"]["SlotIndex"]["value"])

            if where[0] != ZERO and where not in placed.get(pal, []):
                found.add(f"character {pal} points to container {where[0]} slot {where[1]}, which does not list it")

        for group in self.data["GroupSaveDataMap"]["value"]:
            handles = collections.Counter(str(h["instance_id"]) for h in group["value"]["RawData"]["value"].get("individual_character_handle_ids", []))
            found |= {f"group {group['key']} lists missing character {pal}" for pal in handles if pal not in characters}
            found |= {f"group {group['key']} lists character {pal} {n} times" for pal, n in handles.items() if n > 1}

        stored = collections.defaultdict(list)

        for uid, save in self.dps.items():
            for index, entry in enumerate(dps_entries(save)):
                pal = dps_pal(entry)

                if is_free(entry) and pal != ZERO:
                    found.add(f"{dps_file(uid)} entry {index} is empty but names Pal {pal}")
                elif not is_free(entry):
                    stored[pal].append(f"{dps_file(uid)} entry {index}")

        found |= {f"Pal {pal} is in Level.sav and in {where[0]}" for pal, where in stored.items() if pal in characters}
        locker = self.data.get("InLockerCharacterInstanceIDArray", {"value": []})["value"]
        found |= {f"Pal {listed['InstanceId']['value']} is in Level.sav and in InLockerCharacterInstanceIDArray" for listed in locker if str(listed["InstanceId"]["value"]) in characters}
        found |= {f"Pal {pal} is in {', '.join(where)}" for pal, where in stored.items() if len(where) > 1 or pal == ZERO}

        records = collections.Counter(record_id(record) for record in self.data["DynamicItemSaveData"]["value"]["values"])
        known = set(records) | {ZERO}
        held = collections.Counter()

        for cid, container in self.item_containers().items():
            size = container["SlotNum"]["value"]
            slots = [slot["RawData"]["value"] for slot in container["Slots"]["value"]["values"]]
            uses = collections.Counter(raw["slot_index"] for raw in slots)
            found |= {f"item container {cid} slot {index} holds {n} stacks" for index, n in uses.items() if n > 1}
            found |= {f"item container {cid} lists slot {index} of {size}" for index in uses if not 0 <= index < size}
            found |= {f"item container {cid} slot {raw['slot_index']} holds {raw['count']} items" for raw in slots if raw["count"] <= 0}
            found |= {f"item container {cid} slot {raw['slot_index']} holds {raw['item']['static_id']} without its dynamic item record" for raw in slots if dynamic_id(raw["item"]) not in known}
            held.update(dynamic_id(raw["item"]) for raw in slots if dynamic_id(raw["item"]) != ZERO)

        found |= {f"dynamic item {item} is held in {n} slots" for item, n in held.items() if n > 1}
        found |= {f"dynamic item {item} has {n} records" for item, n in records.items() if n > 1}
        return found

    def files(self):
        return {"Level.sav": self.level} | {player_file(uid): save for uid, save in self.players.items()} | {dps_file(uid): save for uid, save in self.dps.items()}


def same(before, after) -> bool:
    # NaN is not equal to itself, so values that differ by == are compared again as JSON.
    return before == after or json.dumps(before, cls=CustomEncoder) == json.dumps(after, cls=CustomEncoder)


# The world lists that operations touch, with the name each entry is recorded under.
ENTRY_NAMES = {
    "CharacterSaveParameterMap": lambda entry: str(entry["key"]["InstanceId"]["value"]),
    "CharacterContainerSaveData": lambda entry: str(entry["key"]["ID"]["value"]),
    "ItemContainerSaveData": lambda entry: str(entry["key"]["ID"]["value"]),
    "GroupSaveDataMap": lambda entry: str(entry["key"]),
    "DynamicItemSaveData": record_id,
    "InLockerCharacterInstanceIDArray": lambda entry: str(entry["InstanceId"]["value"]),
}

# The lists whose touched entries can be added or removed.
COME_AND_GO = ("CharacterSaveParameterMap", "DynamicItemSaveData", "InLockerCharacterInstanceIDArray")


def entry_list(world, key):
    value = world[key]["value"]
    return value["values"] if key == "DynamicItemSaveData" else value


def without_entries(world, key):
    rest = {name: value for name, value in world[key].items() if name != "value"}
    return rest | {"value": {name: value for name, value in world[key]["value"].items() if name != "values"}} if key == "DynamicItemSaveData" else rest


# What a touched entry must keep: a Pal all but its SlotId, a container all but its slots, a guild all but the handles
# of touched Pals. A touched dynamic item record may change.
def kept(key, entry, pals):
    if key == "CharacterSaveParameterMap":
        entry = copy.deepcopy(entry)
        params(entry).pop("SlotId", None)
        return entry

    if key in ("CharacterContainerSaveData", "ItemContainerSaveData"):
        return {"key": entry["key"], "value": {name: value for name, value in entry["value"].items() if name != "Slots"}}

    if key == "GroupSaveDataMap":
        raw = entry["value"]["RawData"]["value"]
        handles = [h for h in raw.get("individual_character_handle_ids", []) if str(h["instance_id"]) not in pals]
        return {
            "key": entry["key"],
            "value": {name: value for name, value in entry["value"].items() if name != "RawData"},
            "meta": {name: value for name, value in entry["value"]["RawData"].items() if name != "value"},
            "raw": {name: value for name, value in raw.items() if name != "individual_character_handle_ids"},
            "handles": handles,
        }

    return None


# The written world must differ from the original only in the entries the operations touched. Only a Pal that moved to
# or from Dimensional Pal Storage, with its InLocker entry, and a dynamic item record can be added or removed.
def outside_scope(original: SaveFile, written: SaveFile, touched) -> list:
    before = original.gvas.properties
    after = written.gvas.properties
    found = [] if same(original.gvas.header.dump(), written.gvas.header.dump()) else ["header"]
    found += [key for key in before.keys() | after.keys() if key != "worldSaveData" and not same(before.get(key), after.get(key))]
    world_before = before["worldSaveData"]["value"]
    world_after = after["worldSaveData"]["value"]

    for key in world_before.keys() | world_after.keys():
        if not touched.get(key):
            if not same(world_before.get(key), world_after.get(key)):
                found.append(key)
            continue

        if not same(without_entries(world_before, key), without_entries(world_after, key)):
            found.append(key)

        entries = [{ENTRY_NAMES[key](entry): entry for entry in entry_list(world, key)} for world in (world_before, world_after)]
        may_go = touched[key] if key in COME_AND_GO else set()
        found += [f"{key} {name}" for name in sorted((entries[0].keys() ^ entries[1].keys()) - may_go)]

        for name in entries[0].keys() & entries[1].keys():
            if name not in touched[key]:
                if not same(entries[0][name], entries[1][name]):
                    found.append(f"{key} {name}")
            elif not same(*(kept(key, entries[n][name], touched["CharacterSaveParameterMap"]) for n in (0, 1))):
                found.append(f"{key} {name} beyond what the plan changes")

    return found


# A written DPS file must differ from the original only in the touched entries.
def dps_outside_scope(original: SaveFile, written: SaveFile, touched) -> list:
    before = original.gvas.properties
    after = written.gvas.properties
    found = [] if same(original.gvas.header.dump(), written.gvas.header.dump()) else ["header"]
    found += [key for key in before.keys() | after.keys() if key != "SaveParameterArray" and not same(before.get(key), after.get(key))]
    arrays = [{name: value for name, value in props["SaveParameterArray"].items() if name != "value"} for props in (before, after)]
    shells = [{name: value for name, value in props["SaveParameterArray"]["value"].items() if name != "values"} for props in (before, after)]
    entries = [props["SaveParameterArray"]["value"]["values"] for props in (before, after)]

    if not same(arrays[0], arrays[1]) or not same(shells[0], shells[1]) or len(entries[0]) != len(entries[1]):
        return found + ["SaveParameterArray"]

    return found + [f"entry {index}" for index, (a, b) in enumerate(zip(*entries)) if index not in touched and not same(a, b)]


# A moved Pal's fields as a DPS entry holds them, without where it is.
def pal_fields(save: SaveFile, name: str, pal: str, empty):
    if name == "Level.sav":
        entry = next((e for e in save.gvas.properties["worldSaveData"]["value"]["CharacterSaveParameterMap"]["value"] if str(e["key"]["InstanceId"]["value"]) == pal), None)
        values = None if entry is None else full_params(params(entry), empty)
    else:
        values = next((e["SaveParameter"]["value"] for e in dps_entries(save) if not is_free(e) and dps_pal(e) == pal), None)

    return None if values is None else {key: value for key, value in values.items() if key != "SlotId"}


def apply(world_dir: str, plan_path: str, out_dir: str):
    world = World(pathlib.Path(world_dir))
    plan = json.loads(pathlib.Path(plan_path).read_text())
    before = world.violations()
    changes = []

    for operation in plan["operations"]:
        if operation["op"] == "movePal":
            changes.append(world.move_pal(operation["pal"], operation["to"], operation.get("slot")))
        elif operation["op"] == "setParty":
            changes += world.set_party(operation["player"], operation["pals"])
        elif operation["op"] == "giveItem":
            changes.append(world.give_item(operation["player"], operation["item"], operation["count"]))
        elif operation["op"] == "restoreContainer":
            changes += world.restore_container(operation["container"], operation["from"])
        else:
            raise Refused(f"unknown operation {operation['op']}")

    broken = sorted(world.violations() - before)

    if broken:
        raise Refused("the edit would break the save: " + "; ".join(broken[:10]))

    out = pathlib.Path(out_dir)
    files = world.files()

    for name in sorted(world.changed):
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(files[name].encode())

    report = {"changes": changes, "files": sorted(world.changed), "expect": world.expect}
    touched, dps_touched, moved = world.touched, world.dps_touched, world.moved
    empty = world.empty["SaveParameter"]["value"] if world.empty is not None else None
    # Each file is read twice more below; the edited world goes first so that a Level.sav and a DPS file fit in memory.
    del world, files
    fields = collections.defaultdict(dict)

    for name in report["files"]:
        original = SaveFile(pathlib.Path(world_dir) / name)
        written = SaveFile(out / name)
        unexpected = dps_outside_scope(original, written, dps_touched[name]) if name.endswith("_dps.sav") else outside_scope(original, written, touched)

        if unexpected:
            raise Refused(f"{name} would change outside the plan: {', '.join(sorted(unexpected)[:10])}")

        for pal, move in moved.items():
            if move["from"] == name:
                fields[pal]["before"] = pal_fields(original, name, pal, empty)

            if move["to"] == name:
                fields[pal]["after"] = pal_fields(written, name, pal, empty)

            # Only the InLocker entry may name a Pal that left Level.sav.
            if name == "Level.sav" and move["to"] != name and written.raw.count(guid(pal).raw_bytes) != (pal in touched["InLockerCharacterInstanceIDArray"]):
                raise Refused(f"Level.sav would still refer to Pal {pal}")

        del original, written

    altered = [pal for pal in moved if fields[pal].get("before") is None or not same(fields[pal].get("before"), fields[pal].get("after"))]

    if altered:
        raise Refused(f"Pal {', '.join(altered)} would change beyond where it is")

    (out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


# Checks that a world the server saved after an edit still holds what the edit put there.
def verify(world_dir: str, report_path: str):
    world = World(pathlib.Path(world_dir))
    report = json.loads(pathlib.Path(report_path).read_text())
    missing = []

    for expected in report["expect"]:
        if expected["kind"] == "pal":
            slots = world.pals_in(expected["container"]) if expected["container"] in world.character_containers() else {}

            if expected["pal"] not in slots:
                missing.append(f"Pal {expected['pal']} is no longer in container {expected['container']}")

            if "dps" in expected and world.in_dps(expected["pal"]):
                missing.append(f"Pal {expected['pal']} is in Dimensional Pal Storage again")
        elif expected["kind"] == "dps":
            save = world.dps_save(expected["player"])

            if save is None or not any(not is_free(entry) and dps_pal(entry) == expected["pal"] for entry in dps_entries(save)):
                missing.append(f"Pal {expected['pal']} is no longer in the Dimensional Pal Storage of player {expected['player']}")

            if expected["pal"] in world.characters():
                missing.append(f"Pal {expected['pal']} is in Level.sav again")
        elif expected["kind"] == "item":
            slots = world.item_containers().get(expected["container"], {"Slots": {"value": {"values": []}}})["Slots"]["value"]["values"]

            if not any(slot["RawData"]["value"]["item"]["static_id"] == expected["item"] for slot in slots):
                missing.append(f"{expected['item']} is no longer in item container {expected['container']}")
        else:
            slots = world.item_containers().get(expected["container"], {"Slots": {"value": {"values": []}}})["Slots"]["value"]["values"]
            records = {record_id(record) for record in world.data["DynamicItemSaveData"]["value"]["values"]}
            held = {(slot["RawData"]["value"]["item"]["static_id"], dynamic_id(slot["RawData"]["value"]["item"])) for slot in slots}

            for item in expected["items"]:
                gone = not any(static == item["item"] and item["dynamic"] in (ZERO, dynamic) for static, dynamic in held)

                if gone or item["dynamic"] not in records | {ZERO}:
                    missing.append(f"{item['item']} from slot {item['slot']} is no longer in item container {expected['container']}")

    if missing:
        raise Refused("; ".join(missing))

    print(json.dumps({"verified": len(report["expect"])}))


def show(world_dir: str, ref: str):
    world = World(pathlib.Path(world_dir))
    uid = world.player(ref)
    party, palbox = world.party_and_palbox(uid)
    characters = world.characters()

    def pals(cid):
        return [summary(index, pal, params(characters[pal])) for pal, index in sorted(world.pals_in(cid).items(), key=lambda item: item[1]) if pal in characters]

    stored = world.dps_save(uid)
    dps = [] if stored is None else [summary(index, dps_pal(entry), entry["SaveParameter"]["value"], stored=True) for index, entry in enumerate(dps_entries(stored)) if not is_free(entry)]
    inventory_id = container_id(world.player_data(uid)["InventoryInfo"]["value"]["CommonContainerId"])
    items = [
        {"slot": slot["RawData"]["value"]["slot_index"], "item": slot["RawData"]["value"]["item"]["static_id"], "count": slot["RawData"]["value"]["count"]}
        for slot in world.item_containers()[inventory_id]["Slots"]["value"]["values"]
    ]

    print(json.dumps({"player": world.player_names()[uid], "uid": uid, "party": pals(party), "palbox": pals(palbox), "dps": dps, "inventoryId": inventory_id, "inventory": items}))


def main():
    commands = {"apply": (apply, 3), "verify": (verify, 2), "show": (show, 2)}
    command = commands.get(sys.argv[1] if len(sys.argv) > 1 else "")

    if command is None or len(sys.argv) != command[1] + 2:
        print("usage: savetool apply <world> <plan.json> <out> | verify <world> <report.json> | show <world> <player>", file=sys.stderr)
        return 2

    try:
        command[0](*sys.argv[2:])
    except Refused as refusal:
        print(str(refusal), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())

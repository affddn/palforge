using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UAssetAPI;
using UAssetAPI.ExportTypes;
using UAssetAPI.UnrealTypes;
using UAssetAPI.Unversioned;

// Converts cooked UE 5.1 assets to UAssetAPI JSON and back, and edits or compares that JSON exactly. palforge decides
// what to change; the JSON itself never passes through JavaScript numbers, which would round 64-bit integers.
return args switch
{
    ["tojson", var asset, var json, var usmap] => ToJson(asset, json, ReadMappings(usmap)),
    ["fromjson", var json, var asset, var usmap] => FromJson(json, asset, ReadMappings(usmap)),
    ["edit", var json, var edits, var output] => Edit(json, edits, output),
    ["diff", var before, var after] => Diff(before, after),
    _ => Usage(),
};

static int Usage()
{
    Console.Error.WriteLine("usage: uasset-json tojson <in.uasset> <out.json> <mappings.usmap>");
    Console.Error.WriteLine("       uasset-json fromjson <in.json> <out.uasset> <mappings.usmap>");
    Console.Error.WriteLine("       uasset-json edit <in.json> <edits.json> <out.json>");
    Console.Error.WriteLine("       uasset-json diff <before.json> <after.json>");
    return 2;
}

// Usmap(path) opens the file for writing, which fails on the read-only mount the mappings come from.
static Usmap ReadMappings(string path)
{
    var mappings = new Usmap();
    mappings.Read(new UsmapBinaryReader(new MemoryStream(File.ReadAllBytes(path)), mappings));
    return mappings;
}

static int ToJson(string assetPath, string jsonPath, Usmap mappings)
{
    var asset = new UAsset(assetPath, EngineVersion.VER_UE5_1, mappings);

    // Writing, which VerifyBinaryEquality does, overwrites this with the in-memory name count.
    var fileNameCount = asset.Generations[^1].NameCount;

    // An export UAssetAPI could not parse is kept as raw bytes, so its properties would be invisible to the edit.
    var unparsed = asset.Exports.OfType<RawExport>().Select(export => export.ObjectName.ToString()).ToList();

    if (unparsed.Count > 0)
    {
        Console.Error.WriteLine($"{assetPath}: could not parse exports {string.Join(", ", unparsed)}");
        return 1;
    }

    if (!asset.VerifyBinaryEquality() && !ExportDataRoundTrips(asset, assetPath, fileNameCount))
    {
        Console.Error.WriteLine($"{assetPath}: writing the parsed asset does not reproduce its export data; the mappings may not match this game build");
        return 1;
    }

    File.WriteAllText(jsonPath, asset.SerializeJson(Formatting.Indented));
    return 0;
}

static int FromJson(string jsonPath, string assetPath, Usmap mappings)
{
    using var json = File.OpenRead(jsonPath);
    var asset = UAsset.DeserializeJson(json);

    // Mappings are not part of the JSON, so they have to be attached again before writing.
    asset.Mappings = mappings;
    asset.Write(assetPath);
    return 0;
}

// With mappings, UAssetAPI appends the type names of enum properties to the name map while parsing, and its writer
// needs them there, so the header can grow even though no export references the new names. What the mappings decide
// is the export data in the .uexp, which must come back byte for byte.
static bool ExportDataRoundTrips(UAsset asset, string path, int fileNameCount)
{
    var original = Path.ChangeExtension(path, ".uexp");
    var appendedNames = asset.GetNameMapIndexList().Count > fileNameCount;

    if (!appendedNames || !File.Exists(original))
    {
        return false;
    }

    var roundTrip = Path.Combine(Path.GetTempPath(), $"uasset-json-{Guid.NewGuid():N}.uasset");

    try
    {
        asset.Write(roundTrip);
        return File.ReadAllBytes(original).AsSpan().SequenceEqual(File.ReadAllBytes(Path.ChangeExtension(roundTrip, ".uexp")));
    }
    finally
    {
        File.Delete(roundTrip);
        File.Delete(Path.ChangeExtension(roundTrip, ".uexp"));
    }
}

// Strings that look like dates must stay strings, and numbers keep the types UAssetAPI wrote them with.
static JToken ReadJson(string path)
{
    using var reader = new JsonTextReader(File.OpenText(path)) { DateParseHandling = DateParseHandling.None };
    return JToken.ReadFrom(reader);
}

// Edits are a JSON array. {"path": [key or index, ...], "value": <json>} replaces an existing value.
// {"path": [...], "append": <json>, "names": [...]} appends to an existing array, such as an export's properties when
// the game keeps a field at its code default; the names it uses are added to the name map, which UAssetAPI needs.
static int Edit(string jsonPath, string editsPath, string outputPath)
{
    var document = ReadJson(jsonPath);

    foreach (var edit in ReadJson(editsPath).Children())
    {
        var path = edit["path"]?.Children<JValue>().ToList() ?? [];
        var target = path.Aggregate((JToken?)document, Step);

        if (target is null || path.Count == 0)
        {
            Console.Error.WriteLine($"{jsonPath}: no value at {string.Join(".", path)}");
            return 1;
        }

        if (edit["append"] is not { } appended)
        {
            target.Replace(edit["value"]?.DeepClone() ?? JValue.CreateNull());
            continue;
        }

        if (target is not JArray array || document["NameMap"] is not JArray nameMap)
        {
            Console.Error.WriteLine($"{jsonPath}: {string.Join(".", path)} is not an array to append to");
            return 1;
        }

        array.Add(appended.DeepClone());

        foreach (var name in edit["names"]?.Values<string>() ?? [])
        {
            if (name is not null && !nameMap.Values<string>().Contains(name))
            {
                nameMap.Add(name);
            }
        }
    }

    File.WriteAllText(outputPath, document.ToString(Formatting.Indented));
    return 0;
}

static JToken? Step(JToken? current, JValue segment) =>
    segment.Type == JTokenType.Integer
        ? (current as JArray)?.ElementAtOrDefault(segment.Value<int>())
        : (current as JObject)?[segment.Value<string>() ?? ""];

// Prints every changed leaf as a JSON array of {"path", "before", "after"}; a missing side is null.
static int Diff(string beforePath, string afterPath)
{
    var changes = new JArray();
    Compare(ReadJson(beforePath), ReadJson(afterPath), [], changes);
    Console.Out.Write(changes.ToString(Formatting.None));
    return 0;
}

static void Compare(JToken? before, JToken? after, JArray path, JArray changes)
{
    if (before is JObject beforeObject && after is JObject afterObject)
    {
        var keys = beforeObject.Properties().Select(property => property.Name)
            .Union(afterObject.Properties().Select(property => property.Name));

        foreach (var key in keys)
        {
            Compare(beforeObject[key], afterObject[key], [.. path, key], changes);
        }

        return;
    }

    if (before is JArray beforeArray && after is JArray afterArray)
    {
        for (var index = 0; index < Math.Max(beforeArray.Count, afterArray.Count); index++)
        {
            Compare(beforeArray.ElementAtOrDefault(index), afterArray.ElementAtOrDefault(index), [.. path, index], changes);
        }

        return;
    }

    if (!JToken.DeepEquals(before, after))
    {
        changes.Add(new JObject { ["path"] = path, ["before"] = before?.DeepClone(), ["after"] = after?.DeepClone() });
    }
}

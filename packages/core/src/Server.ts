import { Effect, Schema } from "effect";

const defaultWorkDir = "/srv/palforge";
const defaultUpstreamImage = "thijsvanloef/palworld-server-docker:latest";

const withDefault = (value: string) =>
  Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed(value)),
    Schema.withDecodingDefaultKey(Effect.succeed(value)),
  );

export class Server extends Schema.Class<Server>("@palforge/core/Server")({
  name: Schema.NonEmptyString,
  sshHost: Schema.NonEmptyString,
  container: Schema.NonEmptyString,
  worldGuid: Schema.NonEmptyString,
  // Where palforge keeps mappings and build files on the host, outside the game's own volume.
  workDir: withDefault(defaultWorkDir),
  // The server image palforge adds the open-pal start-time guard to.
  upstreamImage: withDefault(defaultUpstreamImage),
  // A host command run after the container's own backup before every deploy, e.g. to copy it off-site.
  backupCommand: Schema.optional(Schema.NonEmptyString),
  // `palctl update --all` updates canaries first, then the other servers once the canaries stay healthy.
  canary: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
}) {}

import { Schema } from "effect";

// Field names follow https://docs.palworldgame.com/api/rest-api/ exactly.
export class ServerInfo extends Schema.Class<ServerInfo>("@palforge/palworld-rest/ServerInfo")({
  version: Schema.String,
  servername: Schema.String,
  description: Schema.String,
  worldguid: Schema.String,
}) {}

export class Player extends Schema.Class<Player>("@palforge/palworld-rest/Player")({
  name: Schema.String,
  accountName: Schema.String,
  playerId: Schema.String,
  userId: Schema.String,
  // The docs name this `ip`; v1.0.5 servers send `iP`. Neither is needed, so both are optional.
  ip: Schema.optional(Schema.String),
  iP: Schema.optional(Schema.String),
  ping: Schema.Number,
  location_x: Schema.Number,
  location_y: Schema.Number,
  level: Schema.Int,
  // In the docs, but v1.0.5 servers leave it out.
  building_count: Schema.optional(Schema.Int),
}) {}

export class Players extends Schema.Class<Players>("@palforge/palworld-rest/Players")({
  players: Schema.Array(Player),
}) {}

export class Metrics extends Schema.Class<Metrics>("@palforge/palworld-rest/Metrics")({
  serverfps: Schema.Number,
  serverfpsaverage: Schema.Number,
  serverframetime: Schema.Number,
  currentplayernum: Schema.Int,
  maxplayernum: Schema.Int,
  basecampnum: Schema.Int,
  uptime: Schema.Int,
  days: Schema.Int,
}) {}

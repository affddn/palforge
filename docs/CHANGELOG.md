# Changelog

## 0.6.0 (2026-11-02)


### Features

* **party:** refuse a live party change during an Arena match
* **save:** move Pals to and from DPS and restore item containers
* **save:** refuse Pals that are on an expedition

## 0.5.0 (2026-11-02)


### Features

* **events:** time-boxed QoL boosts from the open-pal config
* **palctl:** let pack deploy wait for an empty server
* **palctl:** update the game with staging, canaries and rehearsals
* **party:** set an online player's party through a UE4SS mod
* **save:** show and edit saves with palctl save


### Fixes

* **events:** keep event state per server
* **pack:** roll a canary that fails its soak back to vanilla
* **pack:** stage game builds as the image's steam user
* **palworld-rest:** decode the player fields v1.0.5 servers actually send
* **party:** give the loadout folder to the game's user


### Documentation

* add a runbook for pipeline failures

## 0.4.0 (2026-11-02)


### Features

* **palctl:** settings per server, strict config keys and the build each feature was checked on

## 0.3.0 (2026-11-02)


### Features

* **open-pal:** set Feed Box, Cold Food Box and fridge slots up to 444

## 0.2.0 (2026-11-02)


### Features

* **open-pal:** add breeding, Palbox rest, calm workers, crops, storage, lab and tech point features

## 0.1.0 (2026-11-02)


### Features

* **modbuilder:** add a pinned repak and UAssetAPI image for building paks
* **palctl:** build the open-pal pak from the operator config
* **palctl:** deploy the pack with a start-time guard and rollback to vanilla
* **palctl:** dump usmap mappings for a server's game build
* **palctl:** list a server's packaged game assets
* **palctl:** list open-pal features from the operator config


### Fixes

* **pack:** pack with one repak thread so builds are byte-identical


### Documentation

* keep agent instructions short and next to the code
* shorten the README and move the details to docs/

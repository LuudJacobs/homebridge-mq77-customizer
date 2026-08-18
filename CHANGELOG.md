# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [0.4.1] - 2026-08-18

### Changed

- Marked private, since the package is not published. `npm publish` now refuses rather than putting it on the registry by accident
- Installation documents the only route that works, installing from source, rather than leading with an npm package that does not exist

## [0.4.0] - 2026-08-18

First release. Everything below arrived across v0.1.0 to v0.4.0, none of which was published separately.

### Added

- Homebridge platform plugin connecting to one MQTT broker shared by every source
- Pluggable source adapters producing one normalised device model, so the HomeKit mapping never sees a source format
- Zigbee2MQTT source discovering devices and their functions from `bridge/devices`, updating live on joins, renames and removals
- `json-topic` source for publishers that put flat JSON on a topic per device, with properties inferred from the keys seen and unrecognised keys kept rather than dropped
- Sources can be marked rules only, for devices another plugin already publishes to HomeKit
- Password protected web interface listing every device and function, with live values over server sent events
- Tick a function to publish it to HomeKit, applied immediately with no Homebridge restart
- Tile type per endpoint, optional separate accessory per endpoint, and name overrides
- Rename devices whose source does not name them itself
- Filter devices by name, topic, model or manufacturer, and hide anything not in HomeKit
- HomeKit mapping for on/off, brightness, fan speed and swing, thermostat, temperature, humidity, battery and child lock
- Buttons inferred from the actions a device publishes, one service per physical button, with per gesture selection
- Property name to characteristic table, so a new kind of sensor needs no change to the mapper
- Functions with no HomeKit equivalent stay listed and marked, ready for the rules engine
- Persistent state under the Homebridge storage path, kept out of `config.json`

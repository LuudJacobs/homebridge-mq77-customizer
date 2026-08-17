# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

- Homebridge platform plugin connecting to one MQTT broker shared by every source
- Pluggable source adapters producing one normalised device model
- Zigbee2MQTT source discovering devices and their functions from `bridge/devices`, updating live on joins, renames and removals
- Persistent state under the Homebridge storage path, kept out of `config.json`
- Password protected web interface listing every device and function, with live values
- Tick a function to publish it to HomeKit, applied immediately with no Homebridge restart
- Tile type per endpoint, optional separate accessory per endpoint, and accessory name overrides
- Functions with no HomeKit equivalent stay listed and marked rather than hidden
- Brightness, thermostat, temperature, humidity, battery and child lock reach HomeKit
- Buttons inferred from the actions a device publishes, one per physical button
- Property name to characteristic table, so new sensor types need no change to the mapper

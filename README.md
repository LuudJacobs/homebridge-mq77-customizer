# MQTT Customizer 0.1.0

A Homebridge plugin that exposes MQTT devices to HomeKit and links them together, configured from a web interface instead of a config form. Devices and their functions are discovered from the broker, so nothing has to be typed out by hand.

## Requirements

- Node.js 20.19, 22.12 or 24 and up
- Homebridge 1.8 or up
- An MQTT broker, for example Mosquitto
- Zigbee2MQTT, for the Zigbee2MQTT source

## Installation

```
npm install -g homebridge-mqtt-customizer
```

Add the platform to your Homebridge config:

```json
{
  "platform": "MqttCustomizer",
  "name": "MQTT Customizer",
  "broker": { "host": "localhost", "port": 1883 },
  "sources": [
    { "id": "zigbee", "adapter": "zigbee2mqtt", "baseTopic": "zigbee2mqtt" }
  ],
  "web": { "port": 8590, "password": "choose-one" }
}
```

Omitting `sources` falls back to a single Zigbee2MQTT source on base topic `zigbee2mqtt`.

### Source options

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier. Changing it orphans everything configured against the source. |
| `adapter` | `zigbee2mqtt` |
| `baseTopic` | Topic prefix the source publishes under. |
| `rulesOnly` | Keep the devices out of HomeKit and use them only as rule triggers and targets. |

## Usage

This release connects to the broker and builds the device catalog. It publishes no accessories and serves no web interface yet, so there is nothing to configure beyond the platform block above. Run Homebridge with `-D` to see the catalog being discovered.

Selecting which devices and functions reach HomeKit arrives in v0.2.0, the HomeKit mapping in v0.3.0, and the rules engine in v0.5.0.

## Links

[License](https://github.com/LuudJacobs/homebridge-mqtt-customizer/blob/main/LICENSE) • [Changelog](https://github.com/LuudJacobs/homebridge-mqtt-customizer/blob/main/CHANGELOG.md)

# MQ77 Customizer 0.1.0

A Homebridge plugin that exposes MQTT devices to HomeKit and links them together, configured from a web interface instead of a config form. Devices and their functions are discovered from the broker, so nothing has to be typed out by hand.

## Requirements

- Node.js 20.19, 22.12 or 24 and up
- Homebridge 1.8 or up
- An MQTT broker, for example Mosquitto
- Zigbee2MQTT, for the Zigbee2MQTT source

## Installation

```
npm install -g homebridge-mq77-customizer
```

To install a branch directly from source instead, which builds on install:

```
npm install -g git+https://github.com/LuudJacobs/homebridge-mq77-customizer.git#test
```

Add the platform to your Homebridge config:

```json
{
  "platform": "Mq77Customizer",
  "name": "MQ77 Customizer",
  "broker": { "host": "localhost", "port": 1883 },
  "sources": [
    { "id": "zigbee", "adapter": "zigbee2mqtt", "baseTopic": "zigbee2mqtt" }
  ],
  "web": { "port": 8888, "password": "choose-one" }
}
```

The web interface can switch your devices, so `web.password` is required. Without it the interface does not start.

Omitting `sources` falls back to a single Zigbee2MQTT source on base topic `zigbee2mqtt`.

### Source options

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier. Changing it orphans everything configured against the source. |
| `adapter` | `zigbee2mqtt` or `json-topic` |
| `baseTopic` | Topic prefix the source publishes under. |
| `topics` | Flat JSON sources only. Subscription filter, defaulting to everything under the base topic. |
| `setTopicSuffix` | Flat JSON sources only. Usually `set`. Without it the source is read only. |
| `rulesOnly` | Keep the devices out of HomeKit and use them only as rule triggers and targets. |

### Flat JSON sources

`json-topic` reads any publisher that puts flat JSON on a topic per device. Properties are inferred from the keys seen, accumulated across messages, so a partial update carrying one key does not redefine the device.

```json
{ "id": "broadlink", "adapter": "json-topic", "baseTopic": "broadlinkrm",
  "setTopicSuffix": "set", "rulesOnly": true },
{ "id": "withings", "adapter": "json-topic", "baseTopic": "withingsenv",
  "rulesOnly": true }
```

Recognised keys are `state`, `level`, `speed`, `swing`, `temperature`, `humidity` and `co2_levels`. Anything else still becomes a property, typed from its value, and stays available to the rules engine.

Set `rulesOnly` when another plugin already publishes those devices to HomeKit, so they can be used as triggers and targets without appearing twice.

## Usage

Open `http://<your-homebridge-host>:8888` and sign in with the password from the config. A password is required, the web interface refuses to start without one.

Every device found on the broker is listed with all of its functions, grouped into functions, settings and diagnostics. Tick a function to publish it to HomeKit. Changes take effect immediately, with no Homebridge restart.

Per device you can also:

- choose the tile HomeKit shows, Switch, Outlet, Lightbulb or Fan
- publish each endpoint as its own accessory, for multi channel switches
- rename the device, using the pencil in the card header, for sources that do not name devices themselves. Zigbee2MQTT does, so rename those in Zigbee2MQTT and the new name arrives here on its own

Functions with no HomeKit equivalent are still listed and marked, and stay available to the rules engine rather than being hidden.

### What reaches HomeKit

| Function | Becomes |
| --- | --- |
| on/off | Switch, Outlet, Lightbulb or Fan, your choice |
| brightness | Brightness on a Lightbulb |
| temperature, humidity | their sensor services |
| battery | a battery reading on the accessory, with a low warning |
| child lock | the physical controls lock on the tile |
| climate | a Thermostat, using the temperature range the device declares |
| speed, swing | a Fan with rotation speed and swing |
| button actions | one button per physical button, mapped to single, double and long press |

Button names and gestures are worked out from the action names the device publishes, so a double rocker becomes three buttons without anything being typed out. Gestures HomeKit has no equivalent for, such as triple press, stay available to the rules engine.

The rules engine arrives in v0.5.0.

## Upgrading from MQTT Customizer

The plugin used to be called MQTT Customizer. Renaming it changes the platform Homebridge looks for, so update `config.json`:

```json
"platform": "Mq77Customizer"
```

Selections saved under the old name are picked up automatically the first time the renamed plugin starts. The old file is left in place rather than moved.

Homebridge may offer to remove accessories belonging to the plugin under its former name. That is safe to accept.

## Links

[License](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/LICENSE) • [Changelog](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/CHANGELOG.md)

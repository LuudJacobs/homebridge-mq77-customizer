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

To install a branch directly from source instead, which builds on install:

```
npm install -g git+https://github.com/LuudJacobs/homebridge-mqtt-customizer.git#test
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

The web interface can switch your devices, so `web.password` is required. Without it the interface does not start.

Omitting `sources` falls back to a single Zigbee2MQTT source on base topic `zigbee2mqtt`.

### Source options

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier. Changing it orphans everything configured against the source. |
| `adapter` | `zigbee2mqtt` |
| `baseTopic` | Topic prefix the source publishes under. |
| `rulesOnly` | Keep the devices out of HomeKit and use them only as rule triggers and targets. |

## Usage

Open `http://<your-homebridge-host>:8590` and sign in with the password from the config. A password is required, the web interface refuses to start without one.

Every device found on the broker is listed with all of its functions, grouped into functions, settings and diagnostics. Tick a function to publish it to HomeKit. Changes take effect immediately, with no Homebridge restart.

Per device you can also:

- choose the tile HomeKit shows, Switch, Outlet, Lightbulb or Fan
- publish each endpoint as its own accessory, for multi channel switches
- rename the accessory

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
| button actions | one button per physical button, mapped to single, double and long press |

Button names and gestures are worked out from the action names the device publishes, so a double rocker becomes three buttons without anything being typed out. Gestures HomeKit has no equivalent for, such as triple press, stay available to the rules engine.

The rules engine arrives in v0.5.0.

## Links

[License](https://github.com/LuudJacobs/homebridge-mqtt-customizer/blob/main/LICENSE) • [Changelog](https://github.com/LuudJacobs/homebridge-mqtt-customizer/blob/main/CHANGELOG.md)

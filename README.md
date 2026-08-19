# MQ77 Customizer 0.6.1

A Homebridge plugin that exposes MQTT devices to HomeKit and links them together, configured from a web interface instead of a config form. Devices and their functions are discovered from the broker, so nothing has to be typed out by hand.

## Requirements

- Node.js 20.19, 22.12 or 24 and up
- Homebridge 1.8 or up
- An MQTT broker, for example Mosquitto
- Zigbee2MQTT, for the Zigbee2MQTT source

## Installation

Not published to npm. Install from source, which builds on install:

```
npm install -g git+https://github.com/LuudJacobs/homebridge-mq77-customizer.git#main
```

Use `#test` instead of `#main` to run what is being tested rather than the last release.

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

Set `web.zigbee2mqttUrl` to add a link to the Zigbee2MQTT interface in the tab bar. It has to be a full address starting with `http://` or `https://`, and is left out entirely when unset.

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

Accessory names are corrected to what HomeKit accepts, which must start and end with a letter or number. A name like `Gang licht (voordeur)` is published as `Gang licht voordeur`. The name shown here is left as you wrote it.

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

## Rules

Rules live in two tabs. Automation links devices together: when something happens on one, send something to another. Rules work across sources, so a Zigbee button can drive an infrared blaster, and apply the moment they are saved.

A rule is a trigger, any number of conditions that must hold, and one or more actions. Actions can be delayed.

An action either sends a fixed value or matches whatever set the rule off, which is how one device is made to follow another. A copied value is restated in the target's own terms, so a switch that says `ON` can drive one that expects `true`, and a dimmer counting to 254 can drive one counting to 100.

Anything readable can be a trigger or a condition, including functions that never reach HomeKit. Anything writable can be an action.

### Mirror devices

The Mirror devices tab asks a simpler question than Automation: which devices, and which of their functions should stay in step. Every member is both a trigger and a target, so changing any one of them brings the rest into line.

Functions are matched on meaning rather than on name, so a socket calling its on/off `state` mirrors a two channel switch calling the same thing `state_l1`. Where a device has more than one function with that meaning, you choose which.

A member that already holds the value is left alone, and after a write the group is left to settle, one and a half seconds by default. Both are needed. The first handles the normal case where every device confirms; the second handles the one where they do not, since a device reporting its old state once more is indistinguishable from someone flipping a switch, and acting on it would send the group back the other way for ever.

The cost is that flipping a mirrored device again within the settling window is ignored, and devices that disagree are retried once per window rather than as fast as they can talk. Set it per rule between 0.25 and 60 seconds. Below a quarter of a second two devices that disagree can trade places fast enough to look like the runaway the window exists to prevent.

Two things guard against a pair of rules setting each other off:

- a rule will not run more often than its rate limit, one second by default
- a rule that runs more than twenty times in ten seconds is turned off and logged, on the assumption it is triggering itself

Rules never run on retained messages, so reconnecting to the broker cannot replay yesterday's button press.

Recent activity is listed under the rules, including rules that declined to run and why.

## Upgrading from MQTT Customizer

The plugin used to be called MQTT Customizer. Renaming it changes the platform Homebridge looks for, so update `config.json`:

```json
"platform": "Mq77Customizer"
```

Selections saved under the old name are picked up automatically the first time the renamed plugin starts. The old file is left in place rather than moved.

Homebridge may offer to remove accessories belonging to the plugin under its former name. That is safe to accept.

## Links

[License](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/LICENSE) • [Changelog](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/CHANGELOG.md)

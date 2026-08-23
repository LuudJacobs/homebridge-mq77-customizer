# MQ77 Customizer 0.13.0

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
  "broker": { "address": "localhost:1883" },
  "sources": [
    { "id": "zigbee", "adapter": "zigbee2mqtt", "baseTopic": "zigbee2mqtt" }
  ],
  "web": { "port": 8888, "password": "choose-one" }
}
```

`broker.address` is a host with an optional port, `localhost:1883` by default. Leave the port off to use 1883. If the broker wants credentials, tick `broker.requiresAuth` and fill in `broker.username` and `broker.password`.

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
| `devices` | Flat JSON sources only. Functions a device has that it may never report. |

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

#### Describing a device

A flat JSON topic carries no schema, so a function is only known once it has turned up in a payload. A fan that reports nothing but `state` until someone changes its speed has no speed to tick. Name the missing functions and they are there from the moment the device first reports:

```json
{ "id": "broadlink", "adapter": "json-topic", "baseTopic": "broadlinkrm",
  "setTopicSuffix": "set",
  "devices": [{ "topic": "fan_office", "properties": ["speed", "swing"] }] }
```

`topic` is the part after the base topic, so `broadlinkrm/fan_office` is written as `fan_office`, though the whole topic is accepted too. Only recognised keys can be named, since a name on its own says nothing about the kind of value it carries. A function the device does report is left exactly as reported.

What was described is logged at startup, so a topic that matches no device is visible rather than silent.

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

A rule is one or more triggers and one or more outcomes. Any trigger fires the rule. Actions can be delayed.

An outcome is a condition and the actions to take when it holds. The first outcome whose condition holds runs and the rest are skipped, which is if, else if and else. Any outcome may be left without a condition, which means it always holds, so nothing after it can run. That is allowed rather than prevented. The activity list says which outcome ran, by position.

Conditions are groups joined by **or**, each group a set of tests joined by **and**, and any group can be negated with **not**. That covers every boolean expression: `(A and B) or (C and (D and E))` is the same as `(A and B) or (C and D and E)`, which is two levels. A deeper expression written by hand into `state.json` still works and is left untouched by the editor.

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

### Sliders

A dimmer driven from buttons. Pick the level, say how many steps it has, and set the buttons that move it. One press moves one step. Either button switches the device on when it is off: up goes to the level it comes on at, down to the bottom of the range, since a button pressed at a dark light is a request for light. Down from the first step switches it off rather than leaving a light at zero brightness and still on. A level nothing has reported counts as off, so the first press is a step up to one.

Written as automations this is four to six rules that only make sense together, which is why it is one object. The device stays an ordinary device: the same properties are still there for automations and mirror groups, and what a slider does shows in the Activity tab like anything else.

Coming on from off lands where the device says it should. Zigbee2MQTT keeps that as `level_config.on_level`, and a device that has one already knows the answer. "On at" overrides it for a device that has no such setting, and without either the slider comes on at the first step. It then carries on from the nearest step to wherever it landed.

Each of the four buttons takes several triggers, so one slider can be driven by more than one remote.

Stepping counts from what the slider was last told for a couple of seconds, rather than from what the device last reported. A held button sends faster than a light reports back, so reading the device each time would work every press out from the same value and move one step in total.

### Naming and grouping

Every device takes a name, a room and a kind, set in its panel. They are for this interface: HomeKit keeps rooms in the Home app, where no accessory can set or read them.

A name of its own replaces the source's, with the room in front of it when both are set. A room on its own leaves the name alone, since it is there for grouping. The kind puts a small icon in the card header. The device list can be sorted by Room or by Type, and the rule lists by Room. Either groups the list under headings, with anything unset last.

A rule is named by where it acts rather than where it is set off from: a button in the hall turning on a lamp in the study is a study rule. Its rooms are said in front of its name, `Study: Nightlight toggle`, or `Kitchen / Study: Evening` when it reaches several, and left off under a room heading which has said it already. A rule reaching two rooms is listed under both.

Marking a device as a Controller puts its button presses in the Activity tab, with their own filter. Only marked devices: every remote in the house reporting in would bury the rules.

The name reaches HomeKit only where the source names nothing itself, which is the flat JSON publishers. Zigbee2MQTT owns its own names, so one set here stays in this interface. Renaming never changes an accessory's identity, so nothing is lost in the Home app either way.

### Map

The Map tab draws the Zigbee network: what reaches the hub directly and what reaches it through something else. Every link found is drawn, and the route each device uses back to the hub is picked out.

A scan questions every device in turn, so it takes minutes on a mesh of any size and only runs when asked for. Zigbee2MQTT only: a flat JSON source has no network to describe.

The Activity tab lists what the rules have been doing, newest first, including the ones that decided not to run and why. Each entry says whether it came from an automation or a mirror.

## Upgrading from MQTT Customizer

The plugin used to be called MQTT Customizer. Renaming it changes the platform Homebridge looks for, so update `config.json`:

```json
"platform": "Mq77Customizer"
```

Selections saved under the old name are picked up automatically the first time the renamed plugin starts. The old file is left in place rather than moved.

Homebridge may offer to remove accessories belonging to the plugin under its former name. That is safe to accept.

## Links

[License](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/LICENSE) • [Changelog](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/CHANGELOG.md)

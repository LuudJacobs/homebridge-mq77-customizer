# MQ77 Customizer 1.5.0

**This Homebridge plugin has been 100% vibe coded using Claude Code.**

A Homebridge plugin that exposes MQTT devices to HomeKit and links them together, configured from a web interface instead of a config form. Devices and their functions are discovered from the broker, so nothing has to be typed out by hand.

## Requirements

- Node.js 20.19, 22.12 or 24 and up
- Homebridge 1.8 or up
- An MQTT broker, for example Mosquitto
- Zigbee2MQTT, for the Zigbee2MQTT source

## Installation

Install it the way you install any Homebridge plugin, from the Plugins screen of the Homebridge UI or from the command line:

```
hb-service add homebridge-mq77-customizer
```

## Settings

Everything is set in the plugin's settings form in the Homebridge UI, and each field says what it is for. There are three things to fill in:

- **MQTT Broker**, where your broker is and what it wants to be called
- **Sources**, one per publisher on that broker. A Zigbee2MQTT source needs its base topic, `zigbee2mqtt` unless you changed it. With no sources at all, that is what is assumed
- **Web Interface**, a port and a password. The interface can switch your devices, so it refuses to start without one

Everything else, which devices reach HomeKit and what they do between them, is set in the web interface itself.

### Sources

Two kinds. **Zigbee2MQTT** needs nothing but its base topic: it describes its own devices, so they arrive complete. **Flat JSON topics** reads any publisher that puts flat JSON on a topic per device, working the functions out from the keys it sees. Those accumulate across messages, so a partial update carrying one key does not redefine the device.

Recognised keys are `state`, `level`, `speed`, `swing`, `temperature`, `humidity` and `co2_levels`. Anything else still becomes a function, typed from its value, and stays available to the rules engine.

**Rules only** keeps a source's devices out of HomeKit while leaving them usable as rule triggers and targets. Set it where another plugin already publishes those devices, so they can't appear twice.

**Topic filter** narrows what a flat JSON source listens to, as an MQTT filter, `+` standing for one level and `#` for the rest. Everything under the base topic by default.

**Command topic suffix** is what is added to a device's topic to write to it, usually `set`. Without one the source is read only.

### Describing a device

A flat JSON topic carries no schema, so a function is only known once it has turned up in a payload. A fan that reports nothing but `state` until somebody changes its speed has no speed to tick. Name the missing functions under **Described devices** and they are there from the moment the device first reports.

A device is named by the part of its topic after the base topic: one publishing on `<base topic>/kitchen_fan` is written as `kitchen_fan`, though the whole topic is accepted too. Only the recognised keys above can be named, since a name on its own says nothing about the kind of value it carries. A function the device does report is left exactly as reported.

What was described is logged at startup, so a topic that matches no device is visible rather than silent.

## Usage

Open `http://<your-homebridge-host>:8888`, or whichever port you set, and sign in with the password from the settings.

Keep it on your own network. Anybody who gets past that one password can switch every device the plugin publishes, so the port does not belong on the open internet or behind a port forward. Reach it from outside through a VPN, the way you would reach Homebridge itself.

Every device found on the broker is listed with all of its functions, grouped into functions, settings and diagnostics and listed by name within each. Tick a function to publish it to HomeKit. Changes take effect immediately, with no Homebridge restart.

Per device you can also:

- choose the HomeKit tile: Switch, Outlet, Lightbulb or Fan
- publish each endpoint as its own accessory, for multi channel switches
- give it a name, a room and a kind, which this interface uses to label and group it

Functions with no HomeKit equivalent are still listed and marked, and stay available to the rules engine rather than being hidden.

Accessory names are corrected to what HomeKit accepts, which must start and end with a letter or number. A name in brackets, `Hall light (front door)`, is published as `Hall light front door`. The name shown here is left as you wrote it.

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

### Naming and grouping

Every device takes a name, a room and a kind, set in its panel. They are for this interface: HomeKit keeps rooms in the Home app, where no accessory can set or read them.

Marking a device as a Controller puts its button presses in the Activity tab, with their own filter. Only marked devices: every remote in the house reporting in would bury the rules.

The name reaches HomeKit only where the source names nothing itself, which is the flat JSON publishers. Zigbee2MQTT owns its own names, so one set here stays in this interface. Renaming never changes an accessory's identity, so nothing is lost in the Home app either way.

### Last seen and retainment

A device card says when the device was last heard, and its panel says the timestamp behind that along with whether the broker keeps its messages.

Both come from the source rather than from this plugin. When a message reached the broker is not an answer to when a device spoke: a retained message is replayed the moment the plugin connects, which would have every retaining device looking as though it had just reported. Zigbee2MQTT publishes the real answer once `advanced.last_seen` is set to something other than `disable`, and a flat JSON publisher that puts a `last_seen` in its payload is taken at its word the same way. A device that publishes no such time shows none, and sorting by Last seen puts those last.

Whether messages are retained is read from Zigbee2MQTT's own configuration, where three things decide it: the device's own `retain`, the `device_options` defaults it otherwise inherits, and `mqtt.force_disable_retain`, which overrides both. A source that keeps no such configuration says nothing rather than guessing.

### Controllers

The Controllers tab lists every device marked as a Controller, one table per remote, saying what each of its buttons sets off. A button no rule answers reads as `none`, or `In HomeKit` where the press reaches HomeKit as well, said under any rules it does answer. The Unused buttons and HomeKit buttons ticks in the header say which of those lines are wanted, and a button neither tick keeps is left out. Download writes the whole overview to `controller-config.md`, which follows the tick: hidden buttons are left out of the file too.

### Map

The Map tab draws the Zigbee network: what reaches the hub directly and what reaches it through something else. Every link found is drawn, and the route each device uses back to the hub is picked out.

A scan questions every device in turn, so it takes minutes on a mesh of any size and only runs when asked for. Zigbee2MQTT only: a flat JSON source has no network to describe.

### Activity

The Activity tab lists what the rules have been doing, newest first, including the ones that decided not to run and why. A press and the rule it set off read as one line, and each entry says which kind of rule it was. Presses that set nothing off have a filter of their own, off by default.

## Rules

Rules live in four tabs: Automation, Mirror devices, Sliders and Timers. Automation is the general one: when something happens on one device, send something to another. All four work across sources, so a Zigbee button can drive an infrared blaster, and apply the moment they are saved.

Across all four:

- anything readable can set a rule off, including functions that never reach HomeKit, and anything writable can be acted on
- an action can copy whatever set the rule off, restated in the target's own terms, so a switch that says `ON` can drive one that expects `true` and a dimmer counting to 254 can drive one counting to 100
- a rule with several outcomes runs the first whose condition holds and skips the rest
- picking what sets a rule off marks any value another rule already uses with a `*`, since two rules on one button press is a mistake nobody sees until both of them run
- rules never run on retained messages, so reconnecting to the broker cannot replay yesterday's button press
- a rule will not run more often than its rate limit, one second by default, and one that runs more than twenty times in ten seconds is switched off and logged on the assumption it is setting itself off

An automation or a timer can be run by hand with the Trigger button beside Save, whether or not it is switched on. Only what has been saved can be run.

### Mirror devices

Which devices, and which of their functions, should stay in step. Every member is both a trigger and a target. Functions are matched on meaning rather than on name, so a socket calling its on/off `state` mirrors a two channel switch calling the same thing `state_l1`.

After a write the group is left to settle, one and a half seconds by default and set per rule between 0.25 and 60 seconds. A device reporting its old state once more is indistinguishable from somebody flipping a switch, so without the pause a group that disagrees would send itself back and forth for ever. The cost is that flipping a mirrored device again inside the window is ignored.

### Timers

A wait between one thing and another: a light coming on, thirty seconds, the light going out again.

The clock starts again if the same thing happens again. It is called off the moment what started it stops being true: told to run when a light came on, it stops caring once the light is off, however that happened. A timer counting when Homebridge restarts is forgotten.

An automation with a delayed action does the first half of this and cannot be called off, which is the difference between the two.

### Sliders

A dimmer driven from buttons. One press moves one step. Down from the first step switches the device off rather than leaving a light at zero brightness and still on, and either stepping button switches it on when it is off.

Coming on from off lands where the device says it should, which Zigbee2MQTT keeps as `level_config.on_level`. "On at" sets it for a device that has no such setting, and without either it comes on at the first step.

Cycle is one button for the whole range: up to the top, back down to off, and up again from there. It starts upward whenever the level was last set by something other than the slider, and ignores a second press within a second, since it is a button to press rather than to hold.

Each button takes several triggers, so one slider can be driven by more than one remote. Stepping counts from what the slider last sent for a couple of seconds rather than from what the device last reported, so a held button that sends faster than the light can answer still climbs.

## Backup settings

Everything set here lives in `state.json` under the Homebridge storage path, alongside a `backups` folder holding the last ten dated copies. One is taken when the plugin starts, before anything is touched, and at most once an hour after that.

The footer offers `back up: download / upload`, along with when the last copy was taken and a way to take one now. Download hands you the lot as a file, which is the only copy that survives losing the machine it runs on. Upload takes one back, after copying what it replaces. The session secret is left out of the download and kept on upload, so a settings file is safe to keep somewhere else and putting one back does not sign you out.

A run that starts with nothing will not write over a file that has something in it. Somebody deleting their last rule is entitled to an empty file, but a run that began empty and is about to stamp on one that is not has misread something, and the file is worth more than the write. It says so in the log and in the interface rather than carrying on.

## Links

[License](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/LICENSE) • [Changelog](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/CHANGELOG.md)

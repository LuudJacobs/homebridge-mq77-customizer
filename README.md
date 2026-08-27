# MQ77 Customizer 1.3.0

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
sudo hb-service add homebridge-mq77-customizer
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

Every device found on the broker is listed with all of its functions, grouped into functions, settings and diagnostics and listed by name within each. Tick a function to publish it to HomeKit. Changes take effect immediately, with no Homebridge restart.

Per device you can also:

- choose the **HomeKit tile**: Switch, Outlet, Lightbulb or Fan
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

A name of its own replaces the source's, with the room in front of it when both are set. A room on its own leaves the name alone, since it is there for grouping. The kind puts a small icon in the card header. The device list can be sorted by Room or by Type, and the rule lists by Room. Either groups the list under headings, with anything unset last.

A rule is named by where it acts rather than where it is set off from: a button in the hall turning on a lamp in the study is a study rule. Its rooms are said in front of its name, `Study: Nightlight toggle`, or `Kitchen / Study: Evening` when it reaches several, and left off under a room heading which has said it already. A rule reaching two rooms is listed under both.

Marking a device as a Controller puts its button presses in the Activity tab, with their own filter. Only marked devices: every remote in the house reporting in would bury the rules.

The name reaches HomeKit only where the source names nothing itself, which is the flat JSON publishers. Zigbee2MQTT owns its own names, so one set here stays in this interface. Renaming never changes an accessory's identity, so nothing is lost in the Home app either way.

### What a device says about itself

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

Rules live in four tabs: Automation, Mirror devices, Sliders and Timers. Automation is the general one, linking devices together: when something happens on one, send something to another. The other three are shapes that would otherwise be several automations that only make sense together. All of them work across sources, so a Zigbee button can drive an infrared blaster, and apply the moment they are saved.

A rule is one or more triggers and one or more outcomes. Any trigger fires the rule. Actions can be delayed.

An outcome is a condition and the actions to take when it holds. The first outcome whose condition holds runs and the rest are skipped, which is if, else if and else. Any outcome may be left without a condition, which means it always holds, so nothing after it can run. That is allowed rather than prevented. The activity list says which outcome ran, by position.

Conditions are groups joined by **or**, each group a set of tests joined by **and**, and any group can be negated with **not**. That covers every boolean expression: `(A and B) or (C and (D and E))` is the same as `(A and B) or (C and D and E)`, which is two levels. A deeper expression written by hand into `state.json` still works and is left untouched by the editor.

An action either sends a fixed value or matches whatever set the rule off, which is how one device is made to follow another. A copied value is restated in the target's own terms, so a switch that says `ON` can drive one that expects `true`, and a dimmer counting to 254 can drive one counting to 100.

Anything readable can be a trigger or a condition, including functions that never reach HomeKit. Anything writable can be an action.

A remote's actions are said as buttons rather than as wire values, `1 Single Long` for `1_single_long` and `Left Double` for `double_left`, and put in the order somebody would read them: buttons by number, then left, right and both, and within each the gestures from a single press to a hold. Anything that cannot be read as a button is left as it is. What is stored is always the value the device uses.

Picking what sets a rule off marks any value another rule already uses with a `*`. Two rules on one button press is a mistake nobody sees until both of them run. Conditions are left unmarked, since asking what a device is doing is something any number of rules may do.

Rules never run on retained messages, so reconnecting to the broker cannot replay yesterday's button press.

### Mirror devices

The Mirror devices tab asks a simpler question than Automation: which devices, and which of their functions should stay in step. Every member is both a trigger and a target, so changing any one of them brings the rest into line.

Functions are matched on meaning rather than on name, so a socket calling its on/off `state` mirrors a two channel switch calling the same thing `state_l1`. Where a device has more than one function with that meaning, you choose which.

A member that already holds the value is left alone, and after a write the group is left to settle, one and a half seconds by default. Both are needed. The first handles the normal case where every device confirms; the second handles the one where they do not, since a device reporting its old state once more is indistinguishable from someone flipping a switch, and acting on it would send the group back the other way for ever.

The cost is that flipping a mirrored device again within the settling window is ignored, and devices that disagree are retried once per window rather than as fast as they can talk. Set it per rule between 0.25 and 60 seconds. Below a quarter of a second two devices that disagree can trade places fast enough to look like the runaway the window exists to prevent.

Two things guard against a pair of rules setting each other off:

- a rule will not run more often than its rate limit, one second by default
- a rule that runs more than twenty times in ten seconds is turned off and logged, on the assumption it is triggering itself

An automation or a timer can be run by hand from its panel, with the Trigger button beside Save. It runs whether or not the rule is switched on, which is the point: trying a rule is what happens before switching it on. The conditions still hold sway, since a rule that does nothing under the conditions in force is worth knowing about. Only what has been saved can be run, so the button is absent until the panel and the stored rule agree again.

### Timers

A wait between one thing and another: a light coming on, thirty seconds, the light going out again.

The clock starts again if the same thing happens again, so a sensor seeing somebody a second time means another full wait rather than a shorter one. Starting is an event: a light saying it is still on is not somebody turning it on, so `is ON` starts a wait when the light comes on and not on every message that mentions it. It is called off the moment what started it stops being so: told to run when a light came on, it stops caring once the light is off, however that happened. For a reading rather than a state, `above 200` say, it keeps counting while the reading stays over the line and stops when it comes back under.

A timer counting when Homebridge restarts is forgotten. Whatever it was going to do stays undone until something starts it again.

An automation with a delayed action does the first half of this and cannot be called off, which is the difference between the two.

### Sliders

A dimmer driven from buttons. Pick the level, say how many steps it has, and set the buttons that move it. One press moves one step. Either button switches the device on when it is off: up goes to the level it comes on at, down to the bottom of the range, since a button pressed at a dark light is a request for light. Down from the first step switches it off rather than leaving a light at zero brightness and still on. A level nothing has reported counts as off, so the first press is a step up to one.

Written as automations this is four to six rules that only make sense together, which is why it is one object. The device stays an ordinary device: the same properties are still there for automations and mirror groups, and what a slider does shows in the Activity tab like anything else.

Coming on from off lands where the device says it should. Zigbee2MQTT keeps that as `level_config.on_level`, and a device that has one already knows the answer. "On at" overrides it for a device that has no such setting, and without either the slider comes on at the first step. That is also what happens in the moments after a restart, before the device has reported anything: the first press goes to the first step, and once it has spoken the level it keeps is used. It then carries on from the nearest step to wherever it landed.

Cycle is one button for the whole range, for a remote with one to spare rather than two. It steps up until the top, turns round there and steps back down to off, and from off it goes up again. It starts upward whenever the level was last set by something other than the slider, so a light dimmed from HomeKit brightens on the next press rather than carrying on down. Unlike the stepping buttons it ignores a second press within a second, since it is a button to press rather than to hold.

Each button takes several triggers, so one slider can be driven by more than one remote.

Stepping counts from what the slider was last told for a couple of seconds, rather than from what the device last reported. A held button sends faster than a light reports back, so reading the device each time would work every press out from the same value and move one step in total.

## Keeping your settings

Everything set here lives in `state.json` under the Homebridge storage path, alongside a `backups` folder holding the last ten dated copies. One is taken when the plugin starts, before anything is touched, and at most once an hour after that.

The footer offers `back up: download / upload`, along with when the last copy was taken and a way to take one now. Download hands you the lot as a file, which is the only copy that survives losing the machine it runs on. Upload takes one back, after copying what it replaces. The session secret is left out of the download and kept on upload, so a settings file is safe to keep somewhere else and putting one back does not sign you out.

A run that starts with nothing will not write over a file that has something in it. Somebody deleting their last rule is entitled to an empty file, but a run that began empty and is about to stamp on one that is not has misread something, and the file is worth more than the write. It says so in the log and in the interface rather than carrying on.

## Upgrading from MQTT Customizer

The plugin used to be called MQTT Customizer. Renaming it changes the platform Homebridge looks for, so the old settings block no longer belongs to any installed plugin. Fill in this plugin's settings screen and delete the old block, or change `platform` in that block to `Mq77Customizer` if you would rather edit the JSON.

Selections saved under the old name are picked up automatically the first time the renamed plugin starts. The old file is left in place rather than moved.

Homebridge may offer to remove accessories belonging to the plugin under its former name. That is safe to accept.

## Links

[License](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/LICENSE) • [Changelog](https://github.com/LuudJacobs/homebridge-mq77-customizer/blob/main/CHANGELOG.md)
